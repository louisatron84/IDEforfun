import { describe, expect, it } from 'vitest'
import { normalizeLayouts, TASKS, type DockNode, type SplitNode, type StackNode } from './layouts'
import { defaultArrangement, placedPanels } from '../renderer/dock/model'

const st = (id: string, panels: string[]): StackNode => ({ kind: 'stack', id, panels, active: panels[0] })

describe('normalizeLayouts', () => {
  it('keeps every default arrangement unchanged', () => {
    const all = Object.fromEntries(TASKS.map((t) => [t, defaultArrangement(t)]))
    expect(normalizeLayouts(all)).toEqual(all)
  })

  it('drops unknown tasks and junk', () => {
    expect(normalizeLayouts(null)).toEqual({})
    expect(normalizeLayouts('x')).toEqual({})
    expect(normalizeLayouts({ nope: st('a', ['files']), run: 42 })).toEqual({})
  })

  it('drops unknown panels and duplicates, and fixes the active tab', () => {
    const raw = { run: { kind: 'split', id: 'n1', dir: 'row', sizes: [0.5, 0.5], children: [
      { kind: 'stack', id: 's1', panels: ['editor', 'bogus', 'output'], active: 'bogus' },
      { kind: 'stack', id: 's2', panels: ['output', 'terminal'], active: 'output' }
    ] } }
    const r = normalizeLayouts(raw).run as SplitNode
    expect(placedPanels(r)).toEqual(['editor', 'output', 'terminal'])
    expect((r.children[0] as StackNode).active).toBe('editor')
    expect((r.children[1] as StackNode).active).toBe('terminal')
  })

  it('fixes bad sizes and collapses what became empty', () => {
    const raw = { debug: { kind: 'split', id: 'n1', dir: 'column', sizes: [2, -1, 'x'], children: [
      st('s1', ['editor']), st('s2', ['bogus']), { kind: 'split', id: 'n2', dir: 'row', sizes: [1], children: [st('s3', ['debug'])] }
    ] } }
    const r = normalizeLayouts(raw).debug as SplitNode
    expect(r.children.map((c) => c.kind)).toEqual(['stack', 'stack'])
    expect(r.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    for (const s of r.sizes) expect(s).toBeGreaterThanOrEqual(0.08)
  })

  it('a Code layout without the editor is dropped (the default is used instead)', () => {
    expect(normalizeLayouts({ code: st('s1', ['files']) })).toEqual({})
    expect(normalizeLayouts({ connect: st('s1', ['graph']) }).connect).toEqual(st('s1', ['graph']))
    expect(normalizeLayouts({ connect: st('s1', ['graph', 'toolbox', 'box']) }).connect).toEqual(st('s1', ['graph', 'toolbox', 'box']))
  })

  it('a split with no direction or a stack with no panels is unusable', () => {
    const bad: unknown = { kind: 'split', id: 'n1', dir: 'diagonal', sizes: [1], children: [st('s1', ['editor'])] }
    expect(normalizeLayouts({ run: bad })).toEqual({})
    expect(normalizeLayouts({ run: { kind: 'stack', id: 's1', panels: [], active: '' } as DockNode })).toEqual({})
  })
})
