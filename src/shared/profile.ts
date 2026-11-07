/**
 * The visual profiler: how long each project function took in the last
 * traced run, from the tracer's `{"t":"prof"}` messages. Ids are the
 * tracer's: `module:qual`, or `module:<module>` for a file's top-level code.
 *
 * - total: from call to return, including the functions it called (counted
 *   once for a function that calls itself);
 * - self: the time in its own lines only, which is what points at slow code.
 */

export interface FnTime {
  calls: number
  totalMs: number
  selfMs: number
}

export interface RunProfile {
  fns: Map<string, FnTime>
  /** `caller→callee` → the callee's total time when called from there. */
  edges: Map<string, number>
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A tracer message as a profile, or null (anything else, or malformed). */
export function parseProf(raw: unknown): RunProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as { t?: unknown; fns?: unknown; edges?: unknown }
  if (m.t !== 'prof' || !Array.isArray(m.fns) || !Array.isArray(m.edges)) return null
  const fns = new Map<string, FnTime>()
  for (const f of m.fns) {
    if (Array.isArray(f) && typeof f[0] === 'string' && Number.isInteger(f[1]) && num(f[2]) && num(f[3])) {
      fns.set(f[0], { calls: f[1] as number, totalMs: f[2], selfMs: f[3] })
    }
  }
  const edges = new Map<string, number>()
  for (const e of m.edges) {
    if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && num(e[2])) edges.set(`${e[0]}→${e[1]}`, e[2])
  }
  return { fns, edges }
}

/** The module an id belongs to: `pkg.a:f` → `pkg.a`, `module:pkg.a` → `pkg.a`. */
const moduleOf = (id: string) => (id.startsWith('module:') ? id.slice(7) : id.slice(0, id.indexOf(':')))

/** Times for the Graph's nodes: per function (Calls view), or the time spent in each file (Modules view). */
export function viewTimes(p: RunProfile, mode: 'modules' | 'calls'): Map<string, FnTime> {
  if (mode === 'calls') return p.fns
  const out = new Map<string, FnTime>()
  for (const [id, t] of p.fns) {
    const m = moduleOf(id)
    const cur = out.get(m) ?? { calls: 0, totalMs: 0, selfMs: 0 }
    cur.calls += t.calls
    cur.selfMs += t.selfMs
    cur.totalMs = cur.selfMs
    out.set(m, cur)
  }
  return out
}

/** 0 (not worth a look) to 3 (most of the time), from a node's own time against the slowest node's. */
export function heatLevel(ms: number, max: number): 0 | 1 | 2 | 3 {
  if (ms < 1 || max <= 0) return 0
  const share = ms / max
  return share >= 0.5 ? 3 : share >= 0.2 ? 2 : share >= 0.05 ? 1 : 0
}

/**
 * Where a function's time comes from: from the start of the program down to
 * it, each step the caller that spent the most time calling the next one.
 */
export function timePath(p: RunProfile, id: string): string[] {
  const callers = new Map<string, [string, number][]>()
  for (const [key, ms] of p.edges) {
    const [from, to] = key.split('→')
    const list = callers.get(to) ?? []
    list.push([from, ms])
    callers.set(to, list)
  }
  const path = [id]
  const seen = new Set(path)
  for (let at = id; ;) {
    const best = (callers.get(at) ?? []).filter(([c]) => !seen.has(c)).sort((a, b) => b[1] - a[1])[0]
    if (!best) break
    at = best[0]
    seen.add(at)
    path.unshift(at)
  }
  return path
}

/** The functions that took the most time in their own code. */
export function slowest(p: RunProfile, n: number): ({ id: string } & FnTime)[] {
  return [...p.fns].map(([id, t]) => ({ id, ...t })).sort((a, b) => b.selfMs - a.selfMs).slice(0, n)
}

export function formatMs(ms: number): string {
  if (ms < 0.05) return '<0.1 ms'
  if (ms < 10) return `${ms.toFixed(1)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
