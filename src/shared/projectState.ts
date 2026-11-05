/**
 * What gets remembered between sessions: the recently opened folders, and for
 * each project its tabs, split layout, cursor positions, terminals and panel.
 * Stored as JSON in the app's data folder (never inside the project).
 */

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
    panel: typeof r.panel === 'string' && /^[\w-]+$/.test(r.panel) ? r.panel : null
  }
}
