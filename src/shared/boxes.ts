/**
 * Connect boxes: what the user filled in, saved in <project>/.forge/boxes.json.
 * Only the API box exists for now. Secrets are never stored here, only the
 * names of the .env variables that hold them.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export interface KeyValue {
  key: string
  value: string
  /** Query parameters: becomes a parameter of the generated function (default = value). */
  arg?: boolean
}

export type BoxAuth =
  | { kind: 'none' }
  | { kind: 'header'; name: string; env: string }
  | { kind: 'query'; name: string; env: string }
  | { kind: 'bearer'; env: string }
  | { kind: 'basic'; userEnv: string; passEnv: string }

/** One field of the response, as found by the test call. */
export interface FieldNode {
  path: string[]
  name: string
  kind: 'value' | 'object' | 'list'
  sample: string
  children: FieldNode[]
}

export interface TestSummary {
  ok: boolean
  /** When it ran (ms since epoch). */
  at: number
  status?: number
  statusText?: string
  count?: number
  ms?: number
  error?: string
  /** The fields found in the response. */
  fields?: FieldNode[]
  /** The records themselves (kept in memory only, never saved). */
  sample?: unknown
}

export interface ApiRequest {
  id: string
  name: string
  method: HttpMethod
  /** A full URL, or a path added to the box's base URL. `{name}` placeholders become arguments. */
  url: string
  query: KeyValue[]
  headers: KeyValue[]
  /** JSON text, for POST / PUT / PATCH. */
  body: string
  /** Values for the URL placeholders, used by the test call. */
  testArgs: Record<string, string>
  /** Where the records are in the response (null: the largest list, chosen by the test call). */
  recordsPath: string[] | null
  /** Ticked fields, as dotted names (`plan.name`), in column order. */
  ticked: string[]
  /** CSV path, relative to the project. */
  output: string
  /** Overrides the generated function name. */
  functionName?: string
  test?: TestSummary
}

export interface ApiBox {
  id: string
  type: 'api'
  name: string
  baseUrl: string
  auth: BoxAuth
  /** The Python file the code goes in: a new file, or the end of an existing one. */
  target: { file: string; mode: 'new' | 'append' }
  /** The module the box sits beside on the Graph. */
  attach: { module: string } | null
  requests: ApiRequest[]
  /** Hash of the code block as Forge last wrote it (null: not written yet). */
  hash: string | null
  /** The hash before that: the newest block may not have been saved (the file had other unsaved edits). */
  prevHash?: string | null
  /** "Keep my edits": the box no longer updates its code. */
  detached: boolean
}

export interface BoxesFile {
  version: 1
  boxes: ApiBox[]
}

// ---------- names ----------

/** A valid Python name from any text: `My API!` → `my_api`. */
export function pyName(text: string): string {
  let s = text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) return 'api'
  if (/^[0-9]/.test(s)) s = '_' + s
  return s
}

/** An environment variable name: (`GitHub`, `TOKEN`) → `GITHUB_TOKEN`. */
export function envName(text: string, suffix: string): string {
  return `${pyName(text).replace(/^_+/, '').toUpperCase() || 'API'}_${suffix}`
}

export function functionNameFor(box: ApiBox, req: ApiRequest): string {
  return req.functionName?.trim() ? pyName(req.functionName) : pyName(`${box.name}_${req.name}`)
}

// ---------- creating ----------

function freshId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let n = 1
  while (used.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export function newRequest(box: ApiBox, name = 'data'): ApiRequest {
  return {
    id: freshId('r', box.requests.map((r) => r.id)),
    name,
    method: 'GET',
    url: '',
    query: [],
    headers: [],
    body: '',
    testArgs: {},
    recordsPath: null,
    ticked: [],
    output: `${pyName(box.name)}_${pyName(name)}.csv`
  }
}

export function newApiBox(existingIds: readonly string[], name = 'API'): ApiBox {
  const box: ApiBox = {
    id: freshId(`${pyName(name).replace(/_/g, '-').replace(/^-+/, '') || 'api'}-`, existingIds),
    type: 'api',
    name,
    baseUrl: '',
    auth: { kind: 'none' },
    target: { file: `api/${pyName(name)}.py`, mode: 'new' },
    attach: null,
    requests: [],
    hash: null,
    detached: false
  }
  box.requests.push(newRequest(box))
  return box
}

/** The module a project-relative Python path is: `api/github.py` → `api.github`. */
export function moduleOfPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/\.pyi?$/i, '').replace(/\/__init__$/, '').split('/').filter(Boolean).join('.')
}

/** Rename a box; until its code is written, the default file (and its place on the Graph) follow the name, and default CSV names always do. */
export function renameBox(box: ApiBox, name: string): void {
  const old = box.name
  box.name = name
  const oldFile = `api/${pyName(old)}.py`
  if (box.hash === null && box.target.mode === 'new' && box.target.file === oldFile) {
    box.target = { ...box.target, file: `api/${pyName(name)}.py` }
    if (!box.attach || box.attach.module === moduleOfPath(oldFile)) box.attach = { module: moduleOfPath(box.target.file) }
  }
  for (const r of box.requests) {
    if (r.output === `${pyName(old)}_${pyName(r.name)}.csv`) r.output = `${pyName(name)}_${pyName(r.name)}.csv`
  }
}

// ---------- boxes.json ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

function normKv(raw: unknown): KeyValue[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isObj).map((x) => ({ key: str(x.key), value: str(x.value), ...(x.arg === true ? { arg: true } : {}) }))
}

function normAuth(raw: unknown): BoxAuth {
  if (!isObj(raw)) return { kind: 'none' }
  switch (raw.kind) {
    case 'header':
    case 'query':
      return { kind: raw.kind, name: str(raw.name), env: str(raw.env) }
    case 'bearer':
      return { kind: 'bearer', env: str(raw.env) }
    case 'basic':
      return { kind: 'basic', userEnv: str(raw.userEnv), passEnv: str(raw.passEnv) }
    default:
      return { kind: 'none' }
  }
}

function normFields(raw: unknown): FieldNode[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isObj).map((f) => ({
    path: Array.isArray(f.path) ? f.path.map((p) => String(p)) : [],
    name: str(f.name),
    kind: f.kind === 'object' || f.kind === 'list' ? f.kind : 'value',
    sample: str(f.sample),
    children: normFields(f.children)
  }))
}

function normTest(raw: unknown): TestSummary | undefined {
  if (!isObj(raw)) return undefined
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const t: TestSummary = { ok: raw.ok === true, at: num(raw.at) ?? 0 }
  if (num(raw.status) !== undefined) t.status = num(raw.status)
  if (typeof raw.statusText === 'string') t.statusText = raw.statusText
  if (num(raw.count) !== undefined) t.count = num(raw.count)
  if (num(raw.ms) !== undefined) t.ms = num(raw.ms)
  if (typeof raw.error === 'string') t.error = raw.error
  if (Array.isArray(raw.fields)) t.fields = normFields(raw.fields)
  return t
}

function normRequest(raw: Record<string, unknown>, box: ApiBox): ApiRequest {
  const req = newRequest(box, str(raw.name, 'data'))
  const taken = new Set(box.requests.map((r) => r.id))
  if (typeof raw.id === 'string' && raw.id && !taken.has(raw.id)) req.id = raw.id
  req.method = HTTP_METHODS.includes(raw.method as HttpMethod) ? (raw.method as HttpMethod) : 'GET'
  req.url = str(raw.url)
  req.query = normKv(raw.query)
  req.headers = normKv(raw.headers)
  req.body = str(raw.body)
  req.testArgs = isObj(raw.testArgs) ? Object.fromEntries(Object.entries(raw.testArgs).map(([k, v]) => [k, String(v)])) : {}
  req.recordsPath = Array.isArray(raw.recordsPath) ? raw.recordsPath.map((p) => String(p)) : null
  req.ticked = Array.isArray(raw.ticked) ? raw.ticked.filter((t): t is string => typeof t === 'string') : []
  if (typeof raw.output === 'string' && raw.output) req.output = raw.output
  if (typeof raw.functionName === 'string' && raw.functionName) req.functionName = raw.functionName
  const test = normTest(raw.test)
  if (test) req.test = test
  return req
}

export function normalizeBoxes(raw: unknown): ApiBox[] {
  const list = isObj(raw) && Array.isArray(raw.boxes) ? raw.boxes : []
  const out: ApiBox[] = []
  for (const item of list) {
    if (!isObj(item) || item.type !== 'api') continue
    const box = newApiBox(out.map((b) => b.id), str(item.name, 'API'))
    if (typeof item.id === 'string' && item.id && !out.some((b) => b.id === item.id)) box.id = item.id
    box.baseUrl = str(item.baseUrl)
    box.auth = normAuth(item.auth)
    if (isObj(item.target) && typeof item.target.file === 'string' && item.target.file) {
      box.target = { file: item.target.file, mode: item.target.mode === 'append' ? 'append' : 'new' }
    }
    box.attach = isObj(item.attach) && typeof item.attach.module === 'string' ? { module: item.attach.module } : null
    box.hash = typeof item.hash === 'string' ? item.hash : null
    if (typeof item.prevHash === 'string') box.prevHash = item.prevHash
    box.detached = item.detached === true
    if (Array.isArray(item.requests)) {
      box.requests = []
      for (const r of item.requests) if (isObj(r)) box.requests.push(normRequest(r, box))
    }
    if (!box.requests.length) box.requests.push(newRequest(box))
    out.push(box)
  }
  return out
}

export function serializeBoxes(boxes: readonly ApiBox[]): BoxesFile {
  return {
    version: 1,
    boxes: boxes.map((b) => ({
      ...b,
      requests: b.requests.map((r) => {
        if (!r.test) return { ...r }
        // Only how the last test call went: nothing from the response (it could end up in git).
        const { ok, at, status, statusText, count, ms, error } = r.test
        const test: TestSummary = { ok, at }
        if (status !== undefined) test.status = status
        if (statusText !== undefined) test.statusText = statusText
        if (count !== undefined) test.count = count
        if (ms !== undefined) test.ms = ms
        if (error !== undefined) test.error = error
        return { ...r, test }
      })
    }))
  }
}
