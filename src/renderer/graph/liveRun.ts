/**
 * Live run feedback: from the tracer's updates to what the Graph shows
 * (which node glows, which lines get sparks, which boxes light up), for the
 * view on screen.
 */
import type { ApiBox } from '../../shared/boxes'
import { requestFunctions } from '../../shared/boxCode'
import { hostOf } from '../../shared/projectGraph'
import { stateOf, type NetRecord } from '../../shared/network'
import type { GraphMode } from './viewModel'

export interface TraceTick {
  /** The project function the program is in now (`module:qual`, or `module:<module>` for top-level code). */
  at: string | null
  /** Caller → callee, and how many times, since the last update. */
  calls: [string, string, number][]
}

/** What the Graph shows now: its view mode, node ids and edges (`from→to`). */
export interface RunView {
  mode: GraphMode
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
  const toView = (id: string) => (view.mode === 'modules' ? moduleOfId(id) : id)
  const eventIds = view.mode === 'events' ? [...view.nodes].filter((id) => id.startsWith('event:')) : []
  const at = tick.at === null ? null : toView(tick.at)
  const glow = at !== null && view.nodes.has(at) ? at : null

  const counts = new Map<string, { from: string; to: string; n: number }>()
  for (const [a, b, n] of tick.calls) {
    const from = toView(a)
    const to = toView(b)
    if (from === to) continue
    const count = (a: string, b: string) => {
      const key = `${a}→${b}`
      const c = counts.get(key)
      if (c) c.n += n
      else counts.set(key, { from: a, to: b, n })
    }
    if (view.mode === 'events' && !view.edges.has(`${from}→${to}`)) {
      // A handler ran: through the event it handles, from the code that emitted it (or from the event alone,
      // when it came from outside the code: a click, a message, a signal).
      const through = eventIds.filter((e) => view.edges.has(`${e}→${to}`))
      const emitted = through.filter((e) => view.edges.has(`${from}→${e}`))
      if (emitted.length) {
        count(from, emitted[0])
        count(emitted[0], to)
      } else if (through.length) count(through[0], to)
      continue
    }
    // In the Modules view a call can go against the import line (callbacks): the spark runs backwards along it.
    if (!view.edges.has(`${from}→${to}`) && !(view.mode === 'modules' && view.edges.has(`${to}→${from}`))) continue
    count(from, to)
  }
  const sparks = [...counts.values()].sort((x, y) => y.n - x.n).slice(0, MAX_SPARKS).map(({ from, to }) => ({ from, to }))

  const active = new Set<string>(tick.calls.map((c) => c[1]))
  if (tick.at) active.add(tick.at)
  const lit = boxes.filter((b) => b.attach && [...requestFunctions(b).values()].some((fn) => active.has(`${b.attach!.module}:${fn}`))).map((b) => b.id)
  return { glow, sparks, boxes: lit }
}

/** A web request on the Graph: a spark from the code that made it to the API it reached. */
export interface NetSpark {
  from: string
  /** The web API node or API box it went to; null when neither is on screen (the source just flashes). */
  to: { node: string } | { box: string } | null
  ok: boolean
}

export function planNetSpark(r: NetRecord, view: RunView, boxes: readonly ApiBox[]): NetSpark | null {
  if (!r.func || r.kind !== 'http') return null
  const module = moduleOfId(r.func)
  const from = view.mode === 'modules' ? module : r.func
  if (!view.nodes.has(from)) return null
  const ok = stateOf(r) !== 'failed'
  const box = boxes.find((b) => b.attach?.module === module && hostOf(b.baseUrl) === r.host.toLowerCase())
  if (box) return { from, to: { box: box.id }, ok }
  const host = `host:${r.host.toLowerCase()}`
  return { from, to: view.nodes.has(host) ? { node: host } : null, ok }
}
