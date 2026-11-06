/**
 * Values seen during a traced run (src/main/runTrace.py summarises them):
 * what each line of the watched function produced, and what went in and came
 * out of each project function. Plus short descriptions for the Pipeline
 * view and the Graph ("table: 1,204 rows × 6 columns", "1,204 → 873 rows").
 */

export interface Summary {
  type: string
  kind: 'dataframe' | 'series' | 'sequence' | 'mapping' | 'value'
  shape?: number[]
  /** [name, dtype] (dtype is '' for lists of dicts). */
  columns?: [string, string][]
  index?: string[]
  rows?: string[][]
  dtype?: string
  name?: string
  len?: number
  sample?: (string | string[])[]
  repr?: string
}

export interface DataPoint {
  var: string
  /** Which time this line set it (in a loop): 1, 2, 3. */
  n: number
  summary: Summary
}

export interface IoRecord {
  func: string
  total: number
  calls: { in: Record<string, Summary>; out: Summary | null }[]
}

export type DataMessage = { kind: 'data'; func: string; line: number; var: string; n: number; summary: Summary } | { kind: 'io'; io: IoRecord }

const isSummary = (v: unknown): v is Summary => !!v && typeof v === 'object' && typeof (v as Summary).type === 'string' && typeof (v as Summary).kind === 'string'

export function parseDataMessage(raw: unknown): DataMessage | null {
  const m = raw as Record<string, unknown> | null
  if (!m || typeof m !== 'object') return null
  if (m.t === 'data') {
    if (typeof m.func !== 'string' || !Number.isInteger(m.line) || typeof m.var !== 'string' || !isSummary(m.summary)) return null
    return { kind: 'data', func: m.func, line: m.line as number, var: m.var, n: Number.isInteger(m.n) ? (m.n as number) : 1, summary: m.summary }
  }
  if (m.t === 'io') {
    const io = m.io as Record<string, unknown> | null
    if (!io || typeof io.func !== 'string' || !Array.isArray(io.calls)) return null
    const calls = io.calls
      .filter((c): c is { in: Record<string, unknown>; out: unknown } => !!c && typeof c === 'object' && !!(c as { in?: unknown }).in && typeof (c as { in?: unknown }).in === 'object')
      .map((c) => ({
        in: Object.fromEntries(Object.entries(c.in).filter(([, v]) => isSummary(v))) as Record<string, Summary>,
        out: isSummary(c.out) ? c.out : null
      }))
    return { kind: 'io', io: { func: io.func, total: Number.isInteger(io.total) ? (io.total as number) : calls.length, calls } }
  }
  return null
}

const num = (n: number) => n.toLocaleString('en-GB')
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`

export function summaryText(s: Summary): string {
  switch (s.kind) {
    case 'dataframe': return `table: ${plural(s.shape?.[0] ?? 0, 'row')} × ${plural(s.shape?.[1] ?? 0, 'column')}`
    case 'series': return `column: ${plural(s.shape?.[0] ?? 0, 'value')}${s.dtype ? ` (${s.dtype})` : ''}`
    case 'sequence': return `${s.type === 'tuple' ? 'tuple' : s.type === 'set' ? 'set' : 'list'} of ${num(s.len ?? 0)}`
    case 'mapping': return `dict of ${num(s.len ?? 0)}`
    default: return s.repr ?? s.type
  }
}

/** What a step did to its (first) input: rows kept or lost, columns added or removed, groups made. '' if nothing to say. */
export function change(input: Summary | null, output: Summary | null, kind: string): string {
  if (!input || !output || input.kind !== 'dataframe' || output.kind !== 'dataframe') return ''
  const before = input.shape?.[0] ?? 0
  const after = output.shape?.[0] ?? 0
  if (kind === 'group') return `${plural(before, 'row')} → ${plural(after, 'group')}`
  if (before !== after) {
    const d = after - before
    return `${num(before)} → ${plural(after, 'row')} (${d < 0 ? '−' : '+'}${num(Math.abs(d))})`
  }
  const a = new Set((input.columns ?? []).map((c) => c[0]))
  const b = new Set((output.columns ?? []).map((c) => c[0]))
  const added = [...b].filter((c) => !a.has(c))
  const removed = [...a].filter((c) => !b.has(c))
  if (added.length) return `+${plural(added.length, 'column')}: ${added.join(', ')}`
  if (removed.length) return `−${plural(removed.length, 'column')}: ${removed.join(', ')}`
  return ''
}

/** This run's data: the watched function's values by line, and every function's inputs and outputs. */
export class DataLog {
  private lines = new Map<string, DataPoint[]>()
  private ios = new Map<string, IoRecord>()
  private watched: string | null = null
  runId = 0

  begin(runId: number): void {
    this.runId = runId
    this.lines = new Map()
    this.ios = new Map()
    this.watched = null
  }

  add(m: DataMessage): void {
    if (m.kind === 'io') {
      this.ios.set(m.io.func, m.io)
      return
    }
    this.watched = m.func
    const key = `${m.func}#${m.line}`
    const list = this.lines.get(key) ?? []
    const i = list.findIndex((p) => p.var === m.var)
    const point = { var: m.var, n: m.n, summary: m.summary }
    if (i >= 0) list[i] = point
    else list.push(point)
    this.lines.set(key, list)
  }

  /** The function traced line by line (null if none). */
  get func(): string | null {
    return this.watched
  }

  /** Values set on a line (the latest for each variable). */
  at(func: string, line: number): DataPoint[] {
    return this.lines.get(`${func}#${line}`) ?? []
  }

  /** Values set anywhere between two lines (a step that spans several). */
  between(func: string, from: number, to: number): DataPoint[] {
    const out: DataPoint[] = []
    for (let l = from; l <= to; l++) out.push(...this.at(func, l))
    return out
  }

  io(func: string): IoRecord | undefined {
    return this.ios.get(func)
  }

  get hasData(): boolean {
    return this.lines.size > 0 || this.ios.size > 0
  }
}
