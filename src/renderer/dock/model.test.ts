import { describe, expect, it } from 'vitest'
import {
  EDITOR, PANEL_IDS, TASKS, activate, defaultArrangement, findStack, insertAtEdge, insertPanel, movePanel, placedPanels, removePanel, resize, setCollapsed, zoneAt,
  type DockNode, type SplitNode, type StackNode
} from './model'

const stack = (id: string, panels: string[], active = panels[0]): StackNode => ({ kind: 'stack', id, panels, active })
const split = (id: string, dir: 'row' | 'column', children: DockNode[], sizes: number[]): SplitNode => ({ kind: 'split', id, dir, children, sizes })

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

/** A small tree: row [ stack s1 (files, git) | column [ stack s2 (editor) | stack s3 (terminal, problems) ] ] */
const tree = (): DockNode => deepFreeze(split('n1', 'row', [stack('s1', ['files', 'git']), split('n2', 'column', [stack('s2', ['editor']), stack('s3', ['terminal', 'problems'])], [0.7, 0.3])], [0.25, 0.75]))

describe('default arrangements', () => {
  it.each(TASKS)('%s places only known panels, each at most once', (task) => {
    const placed = placedPanels(defaultArrangement(task))
    expect(new Set(placed).size).toBe(placed.length)
    for (const p of placed) expect(PANEL_IDS).toContain(p)
  })
  it('code has the editor; connect has the graph but no editor', () => {
    expect(placedPanels(defaultArrangement('code'))).toContain(EDITOR)
    expect(placedPanels(defaultArrangement('connect'))).toContain('graph')
    expect(placedPanels(defaultArrangement('connect'))).not.toContain(EDITOR)
  })
  it('connect has the Toolbox and Box settings beside the graph', () => {
    expect(placedPanels(defaultArrangement('connect'))).toEqual(expect.arrayContaining(['graph', 'toolbox', 'box']))
  })
})

describe('insertPanel', () => {
  it('centre: joins the target stack and becomes active', () => {
    const r = insertPanel(tree(), 'output', 's3', 'center')
    expect(findStack(r, 'output')).toMatchObject({ id: 's3', panels: ['terminal', 'problems', 'output'], active: 'output' })
  })
  it('left/right wrap the target in a row; top/bottom in a column', () => {
    const r = insertPanel(stack('s9', ['editor']), 'where', 's9', 'right') as SplitNode
    expect(r).toMatchObject({ kind: 'split', dir: 'row', sizes: [0.5, 0.5] })
    expect(r.children.map((c) => (c as StackNode).panels)).toEqual([['editor'], ['where']])
    const t = insertPanel(stack('s9', ['editor']), 'terminal', 's9', 'top') as SplitNode
    expect(t.dir).toBe('column')
    expect(t.children.map((c) => (c as StackNode).panels)).toEqual([['terminal'], ['editor']])
  })
  it('next to a stack in a split of the same direction: becomes a sibling sharing the target size', () => {
    const r = insertPanel(tree(), 'where', 's3', 'bottom') as SplitNode
    const col = r.children[1] as SplitNode
    expect(col.children).toHaveLength(3)
    expect((col.children[2] as StackNode).panels).toEqual(['where'])
    expect(col.sizes[0]).toBeCloseTo(0.7)
    expect(col.sizes[1]).toBeCloseTo(0.15)
    expect(col.sizes[2]).toBeCloseTo(0.15)
  })
})

describe('removePanel', () => {
  it('removing the last panel of a stack removes the stack; a one-child split collapses', () => {
    const r = removePanel(tree(), 'editor')!
    // column [ s2 | s3 ] lost s2: s3 takes the column's place
    expect(r).toMatchObject({ kind: 'split', dir: 'row' })
    expect((r as SplitNode).children[1]).toMatchObject({ kind: 'stack', id: 's3' })
    expect((r as SplitNode).sizes).toEqual([0.25, 0.75])
  })
  it('the active panel moves to a neighbour when removed', () => {
    const r = removePanel(activate(tree(), 'problems'), 'problems')!
    expect(findStack(r, 'terminal')).toMatchObject({ panels: ['terminal'], active: 'terminal' })
  })
  it('returns null when nothing is left', () => {
    expect(removePanel(stack('s1', ['files']), 'files')).toBeNull()
  })
})

describe('movePanel', () => {
  it('dropping on its own stack centre is a no-op', () => {
    const t = tree()
    expect(movePanel(t, 'terminal', 's3', 'center')).toEqual(t)
  })
  it("moving a stack's only panel to its own edge is a no-op", () => {
    const t = tree()
    expect(movePanel(t, 'editor', 's2', 'left')).toEqual(t)
  })
  it('moves a panel next to another stack and cleans up behind it', () => {
    const r = movePanel(tree(), 'git', 's2', 'right')
    expect(findStack(r, 'files')!.panels).toEqual(['files'])
    expect(findStack(r, 'git')!.panels).toEqual(['git'])
    expect(placedPanels(r).sort()).toEqual(['editor', 'files', 'git', 'problems', 'terminal'])
  })
})

describe('resize, activate, collapse', () => {
  it('clamps sizes to the 8% minimum and keeps the sum at 1', () => {
    const r = resize(tree(), 'n1', [0.99, 0.01]) as SplitNode
    expect(r.sizes[0]).toBeCloseTo(0.92)
    expect(r.sizes[1]).toBeCloseTo(0.08)
    const z = resize(tree(), 'n1', [-5, 2]) as SplitNode
    expect(z.sizes[0]).toBeCloseTo(0.08)
    expect(z.sizes[0] + z.sizes[1]).toBeCloseTo(1)
  })
  it('unknown split id: unchanged', () => {
    const t = tree()
    expect(resize(t, 'nope', [0.5, 0.5])).toEqual(t)
  })
  it('activate and setCollapsed', () => {
    expect(findStack(activate(tree(), 'problems'), 'problems')!.active).toBe('problems')
    expect(findStack(setCollapsed(tree(), 's3', true), 'terminal')!.collapsed).toBe(true)
  })
})

describe('zoneAt', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 }
  it('centre box, else the nearest edge', () => {
    expect(zoneAt(rect, 50, 50)).toBe('center')
    expect(zoneAt(rect, 5, 50)).toBe('left')
    expect(zoneAt(rect, 95, 40)).toBe('right')
    expect(zoneAt(rect, 50, 3)).toBe('top')
    expect(zoneAt(rect, 50, 97)).toBe('bottom')
  })
})

describe('insertAtEdge', () => {
  it('wraps the whole layout with a new stack on one side, at the given size', () => {
    const r = insertAtEdge(tree(), 'terminal2', 'bottom', 0.3) as SplitNode
    expect(r).toMatchObject({ kind: 'split', dir: 'column', sizes: [0.7, 0.3] })
    expect((r.children[1] as StackNode).panels).toEqual(['terminal2'])
    const l = insertAtEdge(stack('s1', ['editor']), 'files', 'left', 0.2) as SplitNode
    expect(l.sizes).toEqual([0.2, 0.8])
    expect((l.children[0] as StackNode).panels).toEqual(['files'])
  })
})
