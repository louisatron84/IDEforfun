/**
 * What gets remembered between sessions: the recently opened folders, and for
 * each project its tabs, split layout, cursor positions, terminals and panel.
 * Stored as JSON in the app's data folder (never inside the project).
 */


import { TASKS, type TaskId } from './layouts'

export const MAX_RECENT = 12

export interface DocState {
  path: string
  line: number
  col: number
  scrollTop: number
}

export interface GroupState {
  tabs: DocState[]
  /** Path of the tab that was showing. */
  active: string | null
}

export interface WorkspaceState {
  groups: GroupState[]
  activeGroup: number
  /** Shell id of each open terminal ('' = default shell). */
  terminals: string[]
  /** Bottom panel view that was open, or null if the panel was closed. */
  panel: string | null
  /** The task the project was in (Code, Connect, Debug, Run). */
  task: TaskId
  /** The run configuration picked for Run / Debug (null = the open file). */
  runConfig: string | null
  breakpoints: SavedBreakpointState[]
  /** Debugger watch expressions. */
  watches: string[]
  /** Which exceptions pause the debugger (null = the default: uncaught). */
  exceptionFilters: string[] | null
}

export interface SavedBreakpointState {
  path: string
  line: number
  enabled: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
}

const isWinPath = (p: string) => /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')
const pathKey = (p: string) => (isWinPath(p) ? p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : p.replace(/\/+$/, ''))

/** Put `path` first in the recent list (moving it if already there), keeping at most MAX_RECENT. */
export function addRecent(list: string[], path: string): string[] {
  const key = pathKey(path)
  return [path, ...list.filter((p) => pathKey(p) !== key)].slice(0, MAX_RECENT)
}

export function removeRecent(list: string[], path: string): string[] {
  const key = pathKey(path)
  return list.filter((p) => pathKey(p) !== key)
}

export function normalizeRecent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const p of raw) if (typeof p === 'string' && p.trim() && !out.some((q) => pathKey(q) === pathKey(p))) out.push(p)
  return out.slice(0, MAX_RECENT)
}

const int = (v: unknown, min = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : min)

/** Turn a stored (possibly old or hand-edited) workspace state into a valid one. */
export function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const groups: GroupState[] = []
  if (Array.isArray(r.groups)) {
    for (const g of r.groups.slice(0, 2)) {
      if (!g || typeof g !== 'object') continue
      const gr = g as Record<string, unknown>
      const tabs: DocState[] = []
      if (Array.isArray(gr.tabs)) {
        for (const t of gr.tabs.slice(0, 50)) {
          if (!t || typeof t !== 'object') continue
          const tr = t as Record<string, unknown>
          if (typeof tr.path !== 'string' || !tr.path) continue
          tabs.push({ path: tr.path, line: int(tr.line), col: int(tr.col), scrollTop: int(tr.scrollTop) })
        }
      }
      const active = typeof gr.active === 'string' && tabs.some((t) => t.path === gr.active) ? gr.active : tabs[0]?.path ?? null
      groups.push({ tabs, active })
    }
  }
  if (!groups.length) groups.push({ tabs: [], active: null })
  const terminals = Array.isArray(r.terminals)
    ? r.terminals.filter((t): t is string => typeof t === 'string' && /^[\w.-]*$/.test(t)).slice(0, 10)
    : []
  return {
    groups,
    activeGroup: Math.min(int(r.activeGroup), groups.length - 1),
    terminals,
    panel: typeof r.panel === 'string' && /^[\w-]+$/.test(r.panel) ? r.panel : null,
    task: typeof r.task === 'string' && (TASKS as readonly string[]).includes(r.task) ? (r.task as TaskId) : 'code',
    runConfig: typeof r.runConfig === 'string' && r.runConfig ? r.runConfig : null,
    breakpoints: Array.isArray(r.breakpoints) ? r.breakpoints.slice(0, 2000).flatMap((b): SavedBreakpointState[] => {
      if (!b || typeof b !== 'object') return []
      const o = b as Record<string, unknown>
      if (typeof o.path !== 'string' || !o.path || typeof o.line !== 'number' || !Number.isInteger(o.line) || o.line < 0) return []
      const out: SavedBreakpointState = { path: o.path, line: o.line, enabled: o.enabled !== false }
      for (const k of ['condition', 'hitCondition', 'logMessage'] as const) if (typeof o[k] === 'string' && (o[k] as string).trim()) out[k] = o[k] as string
      return [out]
    }) : [],
    watches: Array.isArray(r.watches) ? r.watches.filter((w): w is string => typeof w === 'string' && !!w.trim()).slice(0, 100) : [],
    exceptionFilters: Array.isArray(r.exceptionFilters) ? r.exceptionFilters.filter((f): f is string => typeof f === 'string' && /^[\w-]+$/.test(f)) : null
  }
}
