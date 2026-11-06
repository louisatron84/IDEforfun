/**
 * The dock model: pure operations on a layout tree (splits whose leaves are
 * tab stacks of panel ids). Every function returns a new tree and never
 * changes its input. DockView draws a tree; TaskController keeps one per task.
 */
import { EDITOR, fixSizes, PANEL_IDS, TASKS, type DockNode, type SplitNode, type StackNode, type TaskId } from '../../shared/layouts'

export { EDITOR, PANEL_IDS, TASKS, type DockNode, type SplitNode, type StackNode, type TaskId }
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'

// ---------- default arrangements ----------

export function defaultArrangement(task: TaskId): DockNode {
  let n = 0
  const id = () => `n${++n}`
  const st = (...panels: string[]): StackNode => ({ kind: 'stack', id: id(), panels, active: panels[0] })
  const sp = (dir: 'row' | 'column', parts: [DockNode, number][]): SplitNode => ({ kind: 'split', id: id(), dir, children: parts.map((p) => p[0]), sizes: parts.map((p) => p[1]) })
  switch (task) {
    case 'code':
      return sp('row', [
        [st('files', 'search', 'outline', 'git'), 0.2],
        [sp('column', [[st('editor'), 0.7], [st('terminal', 'problems', 'output', 'tests', 'references', 'calls', 'history'), 0.3]]), 0.58],
        [sp('column', [[st('where'), 0.6], [st('infile'), 0.4]]), 0.22]
      ])
    case 'connect':
      return sp('column', [[sp('row', [[st('files', 'outline'), 0.18], [st('graph'), 0.66], [st('toolbox'), 0.16]]), 0.78], [st('terminal', 'problems', 'output'), 0.22]])
    case 'debug':
      return sp('column', [[sp('row', [[st('editor'), 0.62], [st('debug'), 0.38]]), 0.75], [st('terminal', 'output', 'problems'), 0.25]])
    case 'run':
      return sp('column', [[sp('row', [[st('editor'), 0.6], [st('output', 'tests', 'problems'), 0.4]]), 0.72], [st('terminal'), 0.28]])
  }
}

// ---------- queries ----------

export function placedPanels(root: DockNode): string[] {
  return root.kind === 'stack' ? [...root.panels] : root.children.flatMap(placedPanels)
}

export function findStack(root: DockNode, panel: string): StackNode | null {
  if (root.kind === 'stack') return root.panels.includes(panel) ? root : null
  for (const c of root.children) {
    const s = findStack(c, panel)
    if (s) return s
  }
  return null
}

export function findNode(root: DockNode, id: string): DockNode | null {
  if (root.id === id) return root
  if (root.kind === 'split') {
    for (const c of root.children) {
      const f = findNode(c, id)
      if (f) return f
    }
  }
  return null
}

/** A fresh node id ("n" + one more than the highest number in use). */
export function nextId(root: DockNode): string {
  let max = 0
  const walk = (n: DockNode) => {
    const m = /(\d+)$/.exec(n.id)
    if (m) max = Math.max(max, Number(m[1]))
    if (n.kind === 'split') n.children.forEach(walk)
  }
  walk(root)
  return `n${max + 1}`
}

// ---------- edits ----------

/** Apply `fn` to the node with this id (copying the path to it). */
function mapNode(root: DockNode, id: string, fn: (n: DockNode) => DockNode): DockNode {
  if (root.id === id) return fn(root)
  if (root.kind === 'stack') return root
  let changed = false
  const children = root.children.map((c) => {
    const m = mapNode(c, id, fn)
    if (m !== c) changed = true
    return m
  })
  return changed ? { ...root, children } : root
}

export function activate(root: DockNode, panel: string): DockNode {
  const s = findStack(root, panel)
  if (!s || s.active === panel) return root
  return mapNode(root, s.id, (n) => ({ ...(n as StackNode), active: panel }))
}

export function setCollapsed(root: DockNode, stackId: string, collapsed: boolean): DockNode {
  const s = findNode(root, stackId)
  if (!s || s.kind !== 'stack' || !!s.collapsed === collapsed) return root
  return mapNode(root, stackId, (n) => {
    const { collapsed: _old, ...rest } = n as StackNode
    return collapsed ? { ...rest, collapsed: true } : rest
  })
}

export function resize(root: DockNode, splitId: string, sizes: number[]): DockNode {
  const s = findNode(root, splitId)
  if (!s || s.kind !== 'split') return root
  return mapNode(root, splitId, (n) => ({ ...(n as SplitNode), sizes: fixSizes(sizes, (n as SplitNode).children.length) }))
}

/** Take a panel out; empty stacks and one-child splits disappear. Null if nothing is left. */
export function removePanel(root: DockNode, panel: string): DockNode | null {
  if (root.kind === 'stack') {
    const i = root.panels.indexOf(panel)
    if (i < 0) return root
    const panels = root.panels.filter((p) => p !== panel)
    if (!panels.length) return null
    const active = root.active === panel ? panels[Math.min(i, panels.length - 1)] : root.active
    return { ...root, panels, active }
  }
  const kept: { node: DockNode; size: number }[] = []
  let changed = false
  root.children.forEach((c, i) => {
    const r = removePanel(c, panel)
    if (r !== c) changed = true
    if (r) kept.push({ node: r, size: root.sizes[i] })
  })
  if (!changed) return root
  if (!kept.length) return null
  if (kept.length === 1) return kept[0].node
  return { ...root, children: kept.map((k) => k.node), sizes: fixSizes(kept.map((k) => k.size), kept.length) }
}

/** Put a panel into a stack (centre) or beside it (an edge). A panel already placed is moved. */
export function insertPanel(root: DockNode, panel: string, targetStackId: string, zone: Zone): DockNode {
  const base = findStack(root, panel) ? removePanel(root, panel) : root
  if (!base) return root
  const target = findNode(base, targetStackId)
  if (!target || target.kind !== 'stack') return root
  if (zone === 'center') {
    return mapNode(base, targetStackId, (n) => ({ ...(n as StackNode), panels: [...(n as StackNode).panels, panel], active: panel }))
  }
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const before = zone === 'left' || zone === 'top'
  const fresh: StackNode = { kind: 'stack', id: nextId(base), panels: [panel], active: panel }
  const parent = parentOf(base, targetStackId)
  if (parent && parent.dir === dir) {
    // Become a sibling in the same split, sharing the target's share.
    return mapNode(base, parent.id, (n) => {
      const p = n as SplitNode
      const i = p.children.findIndex((c) => c.id === targetStackId)
      const half = p.sizes[i] / 2
      const children = [...p.children]
      const sizes = [...p.sizes]
      children.splice(before ? i : i + 1, 0, fresh)
      sizes.splice(i, 1, half, half)
      return { ...p, children, sizes }
    })
  }
  const wrapId = `n${Number(fresh.id.slice(1)) + 1}`
  return mapNode(base, targetStackId, (t) => ({
    kind: 'split', id: wrapId, dir, children: before ? [fresh, t] : [t, fresh], sizes: [0.5, 0.5]
  }))
}

/** Drag-and-drop: move a panel to a stack or beside it. Dropping onto itself changes nothing. */
export function movePanel(root: DockNode, panel: string, targetStackId: string, zone: Zone): DockNode {
  const from = findStack(root, panel)
  if (from && from.id === targetStackId && (zone === 'center' || from.panels.length === 1)) return root
  return insertPanel(root, panel, targetStackId, zone)
}

function parentOf(root: DockNode, id: string): SplitNode | null {
  if (root.kind === 'stack') return null
  for (const c of root.children) {
    if (c.id === id) return root
    const p = parentOf(c, id)
    if (p) return p
  }
  return null
}

// ---------- drop zones ----------

/** Where a drop at (x, y) lands on a stack: its centre (middle 40% box) or the nearest edge. */
export function zoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = rect.width ? (x - rect.left) / rect.width : 0.5
  const fy = rect.height ? (y - rect.top) / rect.height : 0.5
  if (fx >= 0.3 && fx <= 0.7 && fy >= 0.3 && fy <= 0.7) return 'center'
  const d: [Zone, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0]
}

/** Add a panel in a new stack along one side of the whole layout, taking `size` of it. */
export function insertAtEdge(root: DockNode, panel: string, zone: Exclude<Zone, 'center'>, size: number): DockNode {
  const base = (findStack(root, panel) ? removePanel(root, panel) : root) ?? root
  const fresh: StackNode = { kind: 'stack', id: nextId(base), panels: [panel], active: panel }
  const before = zone === 'left' || zone === 'top'
  const s = Math.min(0.9, Math.max(0.1, size))
  return {
    kind: 'split', id: `n${Number(fresh.id.slice(1)) + 1}`, dir: zone === 'left' || zone === 'right' ? 'row' : 'column',
    children: before ? [fresh, base] : [base, fresh], sizes: before ? [s, 1 - s] : [1 - s, s]
  }
}
