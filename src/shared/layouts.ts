/**
 * Forge's workspace layout: per task, a tree of splits whose leaves are tab
 * stacks of panels. Shared by the window (which edits it, see
 * src/renderer/dock/model.ts) and the main process (which saves it per user).
 */

export type TaskId = 'code' | 'connect' | 'debug' | 'run'
export const TASKS: readonly TaskId[] = ['code', 'connect', 'debug', 'run']

/** Every panel the workspace knows. */
export const PANEL_IDS = [
  'files', 'search', 'outline', 'git', 'history', 'editor', 'where', 'infile', 'graph',
  'terminal', 'problems', 'output', 'debug', 'tests', 'references', 'calls'
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
