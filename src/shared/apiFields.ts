/**
 * From a test call's JSON response to the API box's tick boxes and CSV rows.
 * The generated Python (boxCode.ts) follows the same rules, so the preview
 * shows exactly what the file will contain.
 */
import type { FieldNode } from './boxes'

export type { FieldNode }

const MAX_DEPTH = 4
const SAMPLE_LEN = 60

type Rec = Record<string, unknown>
const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

export interface RecordList {
  path: string[]
  count: number
}

/** Every list of objects in the response (not inside other lists), largest first. */
export function recordLists(json: unknown): RecordList[] {
  const out: RecordList[] = []
  const isRecordList = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0 && v.every(isObj)
  const walk = (v: unknown, path: string[]) => {
    if (isRecordList(v)) out.push({ path, count: v.length })
    else if (isObj(v) && path.length < MAX_DEPTH) for (const [k, x] of Object.entries(v)) walk(x, [...path, k])
  }
  walk(json, [])
  return out.sort((a, b) => b.count - a.count)
}

function at(json: unknown, path: readonly string[]): unknown {
  let v = json
  for (const p of path) v = isObj(v) ? v[p] : undefined
  return v
}

const asRecord = (v: unknown): Rec => (isObj(v) ? v : { value: v })

/** The records: from `path`, else the largest list, else the response itself as one record. */
export function pickRecords(json: unknown, path: string[] | null): { records: Rec[]; path: string[] | null } {
  if (path) {
    const v = at(json, path)
    if (Array.isArray(v)) return { records: v.map(asRecord), path }
  }
  if (Array.isArray(json)) return { records: json.map(asRecord), path: [] }
  const lists = recordLists(json)
  if (lists.length) return { records: (at(json, lists[0].path) as unknown[]).map(asRecord), path: lists[0].path }
  return { records: [asRecord(json)], path: null }
}

// ---------- JSON text, as Python writes it ----------

function pyString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (ch) => (ch === '\u007f' ? ch : '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')))
}

/** `json.dumps(value)` with Python's defaults (`, ` and `: `, ASCII only). */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return pyString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : value > 0 ? 'Infinity' : value < 0 ? '-Infinity' : 'NaN'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`
  if (isObj(value)) return `{${Object.entries(value).map(([k, v]) => `${pyString(k)}: ${pyJson(v)}`).join(', ')}}`
  return pyString(String(value))
}

/** One CSV cell: empty for null, JSON text for lists, objects and booleans. */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return pyJson(v)
}

// ---------- fields ----------

function shortSample(v: unknown): string {
  const s = typeof v === 'string' ? v : pyJson(v)
  return s.length > SAMPLE_LEN ? s.slice(0, SAMPLE_LEN - 1) + '…' : s
}

export function fieldKey(path: readonly string[]): string {
  return path.join('.')
}

/** The fields of the records, merged over all of them, in first-seen order. */
export function fieldTree(records: readonly Rec[]): FieldNode[] {
  const merge = (into: FieldNode[], rec: Rec, base: string[]) => {
    for (const [name, v] of Object.entries(rec)) {
      let node = into.find((n) => n.name === name)
      if (!node) {
        node = { path: [...base, name], name, kind: 'value', sample: '', children: [] }
        into.push(node)
      }
      if (v === null || v === undefined) continue
      const known = node.sample !== '' || node.children.length > 0 || node.kind !== 'value'
      if (isObj(v) && base.length + 1 < MAX_DEPTH) {
        if (!known) node.kind = 'object'
        if (node.kind === 'object') merge(node.children, v, node.path)
      } else if (!known) {
        node.kind = Array.isArray(v) ? 'list' : 'value'
        node.sample = shortSample(v)
      }
    }
  }
  const tree: FieldNode[] = []
  for (const r of records) merge(tree, r, [])
  return tree
}

/** Ticked to begin with: the top-level plain fields and lists. */
export function defaultTicks(tree: readonly FieldNode[]): string[] {
  return tree.filter((f) => f.kind !== 'object').map((f) => fieldKey(f.path))
}

// ---------- rows ----------

export function rowsFor(records: readonly Rec[], ticked: readonly string[]): Record<string, string>[] {
  return records.map((r) => Object.fromEntries(ticked.map((key) => [key, cell(at(r, key.split('.')))])))
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The start of the CSV file, as Python's csv module writes it. */
export function csvPreview(rows: readonly Record<string, string>[], columns: readonly string[], max = 5): string {
  const lines = [columns.map(csvCell).join(',')]
  for (const r of rows.slice(0, max)) lines.push(columns.map((c) => csvCell(r[c] ?? '')).join(','))
  return lines.map((l) => l + '\r\n').join('')
}
