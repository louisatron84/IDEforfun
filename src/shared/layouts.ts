/**
 * Forge's workspace layout: per task, a tree of splits whose leaves are tab
 * stacks of panels. Shared by the window (which edits it, see
 * src/renderer/dock/model.ts) and the main process (which saves it per user).
 */

export type TaskId = 'code' | 'connect' | 'debug' | 'run'
export const TASKS: readonly TaskId[] = ['code', 'connect', 'debug', 'run']

/** Every panel the workspace knows. */
export const PANEL_IDS = [
  'files', 'search', 'outline', 'git', 'history', 'editor', 'where', 'infile', 'graph', 'toolbox', 'box',
  'terminal', 'problems', 'output', 'debug', 'tests', 'references', 'calls', 'network', 'pipeline'
] as const
export type PanelId = (typeof PANEL_IDS)[number]
/** The code editor: can't be closed, always placed in the Code task. */
export const EDITOR = 'editor'

export interface StackNode {
  kind: 'stack'
  id: string
  panels: string[]
  active: string
  /** Only the tab strip shows (e.g. the terminal drawer after Ctrl+J). */
  collapsed?: boolean
}

export interface SplitNode {
  kind: 'split'
  id: string
  /** row: children side by side; column: stacked top to bottom. */
  dir: 'row' | 'column'
  children: DockNode[]
  /** Fractions of the split, one per child, summing to 1. */
  sizes: number[]
}

export type DockNode = StackNode | SplitNode

/** No part of a split smaller than this. */
export const MIN_SIZE = 0.08

/** `n` sizes that are each at least MIN_SIZE and sum to 1 (bad input becomes equal parts). */
export function fixSizes(sizes: readonly unknown[], n: number): number[] {
  if (n <= 0) return []
  let s = Array.from({ length: n }, (_, i) => {
    const v = sizes[i]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  })
  let total = s.reduce((a, b) => a + b, 0)
  if (total <= 0) s = s.map(() => 1), (total = n)
  s = s.map((v) => v / total)
  const min = Math.min(MIN_SIZE, 1 / n)
  // Raise the small ones to the minimum and take the difference from the others, proportionally.
  for (let round = 0; round < n; round++) {
    const small = s.map((v) => v < min - 1e-12)
    if (!small.some(Boolean)) break
    const fixed = small.filter(Boolean).length * min
    const rest = s.reduce((a, v, i) => (small[i] ? a : a + v), 0)
    s = s.map((v, i) => (small[i] ? min : rest > 0 ? (v / rest) * (1 - fixed) : (1 - fixed) / (n - small.filter(Boolean).length)))
  }
  return s
}

/** What's saved per user: an arrangement per task (missing = that task's default). */
export type SavedLayouts = Partial<Record<TaskId, DockNode>>

/**
 * Turn a saved layouts file (any version, hand-edited, or corrupt) into valid
 * arrangements: unknown panels and duplicates go, sizes are fixed, empty parts
 * collapse. A task whose arrangement is unusable is left out (it gets its
 * default), and so is a Code arrangement without the editor.
 */
export function normalizeLayouts(raw: unknown): SavedLayouts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SavedLayouts = {}
  for (const task of TASKS) {
    const seen = new Set<string>()
    const tree = normalizeNode((raw as Record<string, unknown>)[task], seen, 0, new Set())
    if (!tree) continue
    if (task === 'code' && !seen.has(EDITOR)) continue
    out[task] = tree
  }
  return out
}

const KNOWN = new Set<string>(PANEL_IDS)

function normalizeNode(raw: unknown, seen: Set<string>, depth: number, ids: Set<string>): DockNode | null {
  if (!raw || typeof raw !== 'object' || depth > 12) return null
  const r = raw as Record<string, unknown>
  let id = typeof r.id === 'string' && /^[\w-]{1,32}$/.test(r.id) ? r.id : null
  if (!id) return null
  // Node ids must be unique (edits find nodes by id): rename repeats.
  for (let k = 2; ids.has(id); k++) id = `${String(r.id).slice(0, 24)}-${k}`
  ids.add(id)
  if (r.kind === 'stack') {
    const panels = (Array.isArray(r.panels) ? r.panels : []).filter((p): p is string => typeof p === 'string' && KNOWN.has(p) && !seen.has(p))
    panels.forEach((p) => seen.add(p))
    if (!panels.length) return null
    const active = typeof r.active === 'string' && panels.includes(r.active) ? r.active : panels[0]
    return { kind: 'stack', id, panels, active, ...(r.collapsed === true ? { collapsed: true } : {}) }
  }
  if (r.kind === 'split' && (r.dir === 'row' || r.dir === 'column')) {
    const rawChildren = Array.isArray(r.children) ? r.children : []
    const rawSizes = Array.isArray(r.sizes) ? r.sizes : []
    const kept: { node: DockNode; size: unknown }[] = []
    rawChildren.forEach((c, i) => {
      const n = normalizeNode(c, seen, depth + 1, ids)
      if (n) kept.push({ node: n, size: rawSizes[i] })
    })
    if (!kept.length) return null
    if (kept.length === 1) return kept[0].node
    return { kind: 'split', id, dir: r.dir, children: kept.map((k) => k.node), sizes: fixSizes(kept.map((k) => k.size), kept.length) }
  }
  return null
}
