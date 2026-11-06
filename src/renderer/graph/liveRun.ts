/**
 * Live run feedback: from the tracer's updates to what the Graph shows
 * (which node glows, which lines get sparks, which boxes light up), for the
 * view on screen.
 */
import type { ApiBox } from '../../shared/boxes'
import { requestFunctions } from '../../shared/boxCode'

export interface TraceTick {
  /** The project function the program is in now (`module:qual`, or `module:<module>` for top-level code). */
  at: string | null
  /** Caller → callee, and how many times, since the last update. */
  calls: [string, string, number][]
}

/** What the Graph shows now: its view mode, node ids and edges (`from→to`). */
export interface RunView {
  mode: 'modules' | 'calls'
  nodes: ReadonlySet<string>
  edges: ReadonlySet<string>
}

export interface RunFrame {
  glow: string | null
  sparks: { from: string; to: string }[]
  boxes: string[]
}

export const MAX_SPARKS = 12

/** A tracer message as a tick, 'end', or null (anything else, or malformed). */
export function parseTrace(raw: unknown): TraceTick | 'end' | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as { t?: unknown; at?: unknown; calls?: unknown }
  if (m.t === 'end') return 'end'
  if (m.t !== 'tick' || (m.at !== null && typeof m.at !== 'string') || !Array.isArray(m.calls)) return null
  const calls: [string, string, number][] = []
  for (const c of m.calls) {
    if (Array.isArray(c) && c.length === 3 && typeof c[0] === 'string' && typeof c[1] === 'string' && Number.isInteger(c[2]) && c[2] > 0) calls.push([c[0], c[1], c[2]])
  }
  return { at: m.at, calls }
}

/** The module an id belongs to: `pkg.a:f` → `pkg.a`, `module:pkg.a` → `pkg.a`. */
export function moduleOfId(id: string): string {
  return id.startsWith('module:') ? id.slice(7) : id.slice(0, id.indexOf(':'))
}

export function planFrame(tick: TraceTick, view: RunView, boxes: readonly ApiBox[]): RunFrame {
  const toView = (id: string) => (view.mode === 'calls' ? id : moduleOfId(id))
  const at = tick.at === null ? null : toView(tick.at)
  const glow = at !== null && view.nodes.has(at) ? at : null

  const counts = new Map<string, { from: string; to: string; n: number }>()
  for (const [a, b, n] of tick.calls) {
    const from = toView(a)
    const to = toView(b)
    if (from === to) continue
    // In the Modules view a call can go against the import line (callbacks): the spark runs backwards along it.
    if (!view.edges.has(`${from}→${to}`) && !(view.mode === 'modules' && view.edges.has(`${to}→${from}`))) continue
    const key = `${from}→${to}`
    const c = counts.get(key)
    if (c) c.n += n
    else counts.set(key, { from, to, n })
  }
  const sparks = [...counts.values()].sort((x, y) => y.n - x.n).slice(0, MAX_SPARKS).map(({ from, to }) => ({ from, to }))

  const active = new Set<string>(tick.calls.map((c) => c[1]))
  if (tick.at) active.add(tick.at)
  const lit = boxes.filter((b) => b.attach && [...requestFunctions(b).values()].some((fn) => active.has(`${b.attach!.module}:${fn}`))).map((b) => b.id)
  return { glow, sparks, boxes: lit }
}
