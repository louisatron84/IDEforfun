/**
 * Live network view: the web requests and connections a traced run makes
 * (reported by src/main/runTrace.py as `{"t":"net","r":{...}}`, re-sent as
 * they fill in), and what the Network panel and the Graph do with them:
 * filtering, grouping, a timeline, and comparing with the previous run.
 */

export interface NetRecord {
  /** Unique within a run; later messages with the same id replace earlier ones. */
  id: number
  kind: 'http' | 'socket'
  /** requests, urllib, urllib3, http.client, httpx, aiohttp, socket */
  lib: string
  /** GET, POST... or CONNECT for a plain socket. */
  method: string
  /** Secrets already masked by the tracer. "host:port" for a socket. */
  url: string
  host: string
  status: number | null
  error: string | null
  /** Milliseconds after the run started. */
  start: number
  /** How long it took; null while it's still going. */
  ms: number | null
  /** The project function that made it (`module:qual` or `module:<module>`), or null. */
  func: string | null
  reqHeaders: [string, string][]
  respHeaders: [string, string][]
  reqBody: string | null
  respBody: string | null
  size: number | null
}

export type NetState = 'pending' | 'ok' | 'failed'
export const SLOW_MS = 1000

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null)
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null)
const pairs = (v: unknown): [string, string][] =>
  Array.isArray(v) ? v.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && isStr(p[0]) && isStr(p[1])).map((p) => [p[0], p[1]]) : []

/** A tracer message as a network record, or null (another message, or malformed). */
export function parseNet(raw: unknown): NetRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as { t?: unknown; r?: unknown }
  if (m.t !== 'net' || !m.r || typeof m.r !== 'object') return null
  const r = m.r as Record<string, unknown>
  if (!Number.isInteger(r.id) || (r.kind !== 'http' && r.kind !== 'socket') || !isStr(r.method) || !isStr(r.url) || !isNum(r.start)) return null
  return {
    id: r.id as number,
    kind: r.kind,
    lib: isStr(r.lib) ? r.lib : '',
    method: r.method,
    url: r.url,
    host: isStr(r.host) ? r.host : '',
    status: Number.isInteger(r.status) ? (r.status as number) : null,
    error: strOrNull(r.error),
    start: r.start,
    ms: numOrNull(r.ms),
    func: strOrNull(r.func),
    reqHeaders: pairs(r.reqHeaders),
    respHeaders: pairs(r.respHeaders),
    reqBody: strOrNull(r.reqBody),
    respBody: strOrNull(r.respBody),
    size: numOrNull(r.size)
  }
}

export function stateOf(r: NetRecord): NetState {
  if (r.error || (r.status !== null && r.status >= 400)) return 'failed'
  return r.ms === null ? 'pending' : 'ok'
}

export const isSlow = (r: NetRecord): boolean => r.ms !== null && r.ms >= SLOW_MS

/** "GET api.example.com/users/{n}": the request without its query, ids folded together (for grouping runs). */
export function endpointOf(r: NetRecord): string {
  if (r.kind === 'socket') return `${r.method} ${r.url}`
  const noScheme = r.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const path = noScheme.split(/[?#]/)[0]
  const folded = path
    .split('/')
    .map((seg, i) => (i === 0 ? seg : /^\d+$/.test(seg) ? '{n}' : /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(seg) ? '{id}' : seg))
    .join('/')
  return `${r.method} ${folded}`
}

/** `app.api.fetch` for `app.api:fetch`; `app.api (top level)` for module code. */
export function funcLabel(func: string | null): string {
  if (!func) return '(outside your code)'
  if (func.startsWith('module:')) return `${func.slice(7)} (top level)`
  return func.replace(':', '.')
}

export interface NetFilter {
  text: string
  only: 'all' | 'failed' | 'slow'
}

export function filterRecords(recs: readonly NetRecord[], f: NetFilter): NetRecord[] {
  const q = f.text.trim().toLowerCase()
  return recs.filter((r) => {
    if (f.only === 'failed' && stateOf(r) !== 'failed') return false
    if (f.only === 'slow' && !isSlow(r)) return false
    if (!q) return true
    return [r.method, r.url, String(r.status ?? ''), r.error ?? '', funcLabel(r.func), r.lib].some((s) => s.toLowerCase().includes(q))
  })
}

export interface NetGroup {
  key: string
  label: string
  records: NetRecord[]
  failed: number
  slowest: number
}

export function groupRecords(recs: readonly NetRecord[], by: 'none' | 'host' | 'func'): NetGroup[] {
  const summary = (key: string, label: string, records: NetRecord[]): NetGroup => ({
    key, label, records, failed: records.filter((r) => stateOf(r) === 'failed').length, slowest: Math.max(0, ...records.map((r) => r.ms ?? 0))
  })
  if (by === 'none') return [summary('', '', [...recs])]
  const groups = new Map<string, NetRecord[]>()
  for (const r of recs) {
    const key = by === 'host' ? r.host : r.func ?? ''
    let list = groups.get(key)
    if (!list) groups.set(key, (list = []))
    list.push(r)
  }
  return [...groups]
    .map(([key, list]) => summary(key, by === 'host' ? key || '(unknown host)' : funcLabel(key || null), list))
    .sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || a.label.localeCompare(b.label))
}

export interface Lane {
  id: number
  start: number
  end: number
  lane: number
}

/** Timeline bars: each request from its start to its end (or `now` while pending), overlapping ones on separate lanes. */
export function timelineLanes(recs: readonly NetRecord[], now: number): Lane[] {
  const ends: number[] = []
  return [...recs]
    .sort((a, b) => a.start - b.start || a.id - b.id)
    .map((r) => {
      const end = r.ms === null ? Math.max(now, r.start) : r.start + r.ms
      let lane = ends.findIndex((e) => e <= r.start)
      if (lane < 0) lane = ends.length
      ends[lane] = end
      return { id: r.id, start: r.start, end, lane }
    })
}

export interface RunSide {
  count: number
  avgMs: number
  failed: number
}
export interface CompareRow {
  endpoint: string
  before: RunSide
  after: RunSide
  change: 'new' | 'gone' | 'failing' | 'fixed' | 'slower' | 'faster' | 'more' | 'fewer' | 'same'
}

/** Endpoint by endpoint: what changed between the previous run and this one. */
export function compareRuns(before: readonly NetRecord[], after: readonly NetRecord[]): CompareRow[] {
  const side = (recs: readonly NetRecord[]) => {
    const map = new Map<string, NetRecord[]>()
    for (const r of recs) {
      const e = endpointOf(r)
      let list = map.get(e)
      if (!list) map.set(e, (list = []))
      list.push(r)
    }
    return map
  }
  const sum = (list: NetRecord[] | undefined): RunSide => {
    if (!list?.length) return { count: 0, avgMs: 0, failed: 0 }
    const timed = list.filter((r) => r.ms !== null)
    return {
      count: list.length,
      avgMs: timed.length ? Math.round(timed.reduce((a, r) => a + r.ms!, 0) / timed.length) : 0,
      failed: list.filter((r) => stateOf(r) === 'failed').length
    }
  }
  const b = side(before)
  const a = side(after)
  const rows: CompareRow[] = []
  for (const endpoint of new Set([...b.keys(), ...a.keys()])) {
    const x = sum(b.get(endpoint))
    const y = sum(a.get(endpoint))
    let change: CompareRow['change'] = 'same'
    const failRate = (s: RunSide) => (s.count ? s.failed / s.count : 0)
    if (!x.count) change = 'new'
    else if (!y.count) change = 'gone'
    else if (failRate(y) > failRate(x)) change = 'failing'
    else if (failRate(y) < failRate(x)) change = 'fixed'
    else if (y.avgMs - x.avgMs >= 50 && y.avgMs >= x.avgMs * 1.5) change = 'slower'
    else if (x.avgMs - y.avgMs >= 50 && x.avgMs >= y.avgMs * 1.5) change = 'faster'
    else if (y.count > x.count) change = 'more'
    else if (y.count < x.count) change = 'fewer'
    rows.push({ endpoint, before: x, after: y, change })
  }
  const order: CompareRow['change'][] = ['failing', 'new', 'gone', 'slower', 'more', 'fewer', 'faster', 'fixed', 'same']
  return rows.sort((p, q) => order.indexOf(p.change) - order.indexOf(q.change) || p.endpoint.localeCompare(q.endpoint))
}

/** This run's records and the last run that made any (to compare with). */
export class NetLog {
  private now = new Map<number, NetRecord>()
  private before: NetRecord[] = []
  runId = 0

  begin(runId: number): void {
    if (this.now.size) this.before = this.current
    this.now = new Map()
    this.runId = runId
  }

  /** Forget this run's requests and the last run's. */
  clear(): void {
    this.now = new Map()
    this.before = []
  }

  upsert(r: NetRecord): void {
    this.now.set(r.id, r)
  }

  get(id: number): NetRecord | undefined {
    return this.now.get(id)
  }

  get current(): NetRecord[] {
    return [...this.now.values()].sort((a, b) => a.id - b.id)
  }

  get previous(): NetRecord[] {
    return this.before
  }
}
