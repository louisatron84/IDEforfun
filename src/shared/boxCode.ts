/**
 * The API box's two outputs: the request Forge sends for a test call, and
 * the Python it writes into the project. The code is plain standard-library
 * Python (urllib, json, csv, os) so it runs anywhere with nothing to install,
 * reads secrets from the environment, and is marked with comment lines so
 * Forge can find and update it.
 */
import { envName, functionNameFor, pyName, type ApiBox, type ApiRequest, type BoxAuth } from './boxes'
import { pyJson } from './apiFields'

const PLACEHOLDER = /\{([^{}]+)\}/g

/** The URL's `{placeholders}` as Python parameter names, in order, without repeats. */
export function urlArgs(url: string): string[] {
  const out: string[] = []
  for (const m of url.matchAll(PLACEHOLDER)) {
    const name = pyName(m[1])
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** The .env names the box's auth reads (defaults derived from the box name). */
export function authEnv(box: ApiBox): { kind: BoxAuth['kind']; names: string[] } {
  const a = box.auth
  switch (a.kind) {
    case 'none':
      return { kind: 'none', names: [] }
    case 'header':
    case 'query':
      return { kind: a.kind, names: [a.env || envName(box.name, 'KEY')] }
    case 'bearer':
      return { kind: 'bearer', names: [a.env || envName(box.name, 'TOKEN')] }
    case 'basic':
      return { kind: 'basic', names: [a.userEnv || envName(box.name, 'USER'), a.passEnv || envName(box.name, 'PASSWORD')] }
  }
}

/** Function names for every request (repeats get _2, _3...). */
export function requestFunctions(box: ApiBox): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const r of box.requests) {
    const base = functionNameFor(box, r)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`
    used.add(name)
    out.set(r.id, name)
  }
  return out
}

const hasBody = (req: ApiRequest) => (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && req.body.trim() !== ''

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export type BuiltRequest = { method: string; url: string; headers: Record<string, string>; body?: string }

/** The request a test call sends, with the secrets from `env`. */
export function buildRequest(box: ApiBox, req: ApiRequest, env: Record<string, string | undefined>): BuiltRequest | { error: string } {
  let missingArg = ''
  let url = req.url.trim().replace(PLACEHOLDER, (_m, raw: string) => {
    const v = req.testArgs[pyName(raw)]
    if (v === undefined || v === '') missingArg ||= pyName(raw)
    return encodeURIComponent(v ?? '')
  })
  if (missingArg) return { error: `Fill in a test value for ${missingArg}.` }
  if (!/^https?:\/\//i.test(url) && box.baseUrl.trim()) url = box.baseUrl.trim().replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '')
  if (!/^https?:\/\/[^/]/i.test(url)) return { error: 'The URL must start with http:// or https:// (or set a base URL).' }

  const params = new URLSearchParams()
  for (const q of req.query) if (q.key.trim()) params.append(q.key.trim(), q.value)
  const headers: Record<string, string> = { Accept: 'application/json' }
  for (const h of req.headers) if (h.key.trim()) headers[h.key.trim()] = h.value
  let body: string | undefined
  if (hasBody(req)) {
    try {
      JSON.parse(req.body)
    } catch {
      return { error: "The body isn't valid JSON." }
    }
    body = req.body
    headers['Content-Type'] = 'application/json'
  }

  const auth = authEnv(box)
  const secrets: string[] = []
  for (const name of auth.names) {
    const v = env[name]
    if (!v) return { error: `${name} is not set: add it to .env` }
    secrets.push(v)
  }
  const a = box.auth
  if (a.kind === 'header') headers[a.name.trim() || 'X-Api-Key'] = secrets[0]
  else if (a.kind === 'query') params.append(a.name.trim() || 'api_key', secrets[0])
  else if (a.kind === 'bearer') headers.Authorization = `Bearer ${secrets[0]}`
  else if (a.kind === 'basic') headers.Authorization = `Basic ${base64(`${secrets[0]}:${secrets[1]}`)}`

  const qs = params.toString()
  if (qs) url += (url.includes('?') ? '&' : '?') + qs
  return { method: req.method, url, headers, ...(body !== undefined ? { body } : {}) }
}

// ---------- Python ----------

/** A Python string literal. */
const s = (text: string) => pyJson(text)

/** JSON value → Python literal (None / True / False). */
function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`
  if (typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${s(k)}: ${pyLiteral(x)}`).join(', ')}}`
  return pyJson(v)
}

const docText = (text: string) => text.replace(/["\\]/g, '').replace(/\s+/g, ' ')

function helperCode(box: ApiBox, p: string): string[] {
  const base = box.baseUrl.trim()
  const baseConst = `${p.replace(/^_+/, '').toUpperCase()}_BASE_URL`
  const L: string[] = []
  if (base) L.push(`${baseConst} = ${s(base)}`, '', '')
  L.push(
    `def _${p}_request(method, url, params=None, headers=None, body=None):`,
    `    """Call the ${docText(box.name)} API and return the JSON it sends back (generated by Forge)."""`,
    '    headers = {"Accept": "application/json", **(headers or {})}',
    '    params = dict(params or {})'
  )
  const a = box.auth
  const names = authEnv(box).names
  const secret = (v: string, name: string) => [
    `    ${v} = os.environ.get(${s(name)})`,
    `    if not ${v}:`,
    `        raise RuntimeError(${s(`${name} is not set: add it to .env`)})`
  ]
  if (a.kind === 'header') L.push(...secret('key', names[0]), `    headers[${s(a.name.trim() || 'X-Api-Key')}] = key`)
  if (a.kind === 'query') L.push(...secret('key', names[0]), `    params[${s(a.name.trim() || 'api_key')}] = key`)
  if (a.kind === 'bearer') L.push(...secret('token', names[0]), '    headers["Authorization"] = "Bearer " + token')
  if (a.kind === 'basic') {
    L.push(...secret('user', names[0]), ...secret('password', names[1]),
      '    headers["Authorization"] = "Basic " + base64.b64encode((user + ":" + password).encode("utf-8")).decode("ascii")')
  }
  if (base) {
    L.push(
      '    if not url.startswith(("http://", "https://")):',
      `        url = ${baseConst}.rstrip("/") + "/" + url.lstrip("/")`
    )
  }
  L.push(
    '    if params:',
    '        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)',
    '    data = None',
    '    if body is not None:',
    '        data = json.dumps(body).encode("utf-8")',
    '        headers["Content-Type"] = "application/json"',
    '    request = urllib.request.Request(url, data=data, headers=headers, method=method)',
    '    with urllib.request.urlopen(request, timeout=30) as response:',
    '        return json.loads(response.read().decode("utf-8"))',
    '',
    '',
    `def _${p}_cell(record, key):`,
    '    """One CSV cell: a field of a record (nested fields are joined with dots)."""',
    '    value = record',
    '    for part in key.split("."):',
    '        value = value.get(part) if isinstance(value, dict) else None',
    '    if value is None:',
    '        return ""',
    '    if isinstance(value, (bool, list, dict)):',
    '        return json.dumps(value)',
    '    return str(value)'
  )
  return L
}

function functionCode(box: ApiBox, req: ApiRequest, fn: string, p: string): string[] {
  const args = urlArgs(req.url)
  const queryArgs = req.query.filter((q) => q.key.trim() && q.arg)
  const params = [
    ...args,
    ...queryArgs.map((q) => `${pyName(q.key)}=${s(q.value)}`),
    `output_path=${s(req.output || `${fn}.csv`)}`
  ]
  const L: string[] = [
    `def ${fn}(${params.join(', ')}):`,
    `    """${req.method} ${docText(req.url || '(no URL yet)')} → ${docText(req.output || `${fn}.csv`)} (generated by Forge)."""`
  ]
  const call = [s(req.method)]
  if (args.length) {
    const template = req.url.trim().replace(PLACEHOLDER, (_m, raw: string) => `{${pyName(raw)}}`)
    L.push(`    url = ${s(template)}.format(${args.map((a) => `${a}=urllib.parse.quote(str(${a}), safe="")`).join(', ')})`)
    call.push('url')
  } else call.push(s(req.url.trim()))
  const query = req.query.filter((q) => q.key.trim())
  if (query.length) {
    L.push(`    params = {${query.map((q) => `${s(q.key.trim())}: ${q.arg ? pyName(q.key) : s(q.value)}`).join(', ')}}`)
    call.push('params=params')
  }
  const headers = req.headers.filter((h) => h.key.trim())
  if (headers.length) {
    L.push(`    headers = {${headers.map((h) => `${s(h.key.trim())}: ${s(h.value)}`).join(', ')}}`)
    call.push('headers=headers')
  }
  if (hasBody(req)) {
    try {
      L.push(`    body = ${pyLiteral(JSON.parse(req.body))}`)
    } catch {
      L.push("    body = None  # the body in Forge isn't valid JSON yet")
    }
    call.push('body=body')
  }
  L.push(`    data = _${p}_request(${call.join(', ')})`)
  if (req.recordsPath === null) L.push('    records = data if isinstance(data, list) else [data]')
  else L.push(`    records = data${req.recordsPath.map((k) => `[${s(k)}]`).join('')}`)
  L.push('    records = [r if isinstance(r, dict) else {"value": r} for r in records]')
  if (req.ticked.length) L.push(`    fields = [${req.ticked.map(s).join(', ')}]`)
  else {
    L.push(
      '    fields = []',
      '    for record in records:',
      '        for key in record:',
      '            if key not in fields:',
      '                fields.append(key)'
    )
  }
  L.push(
    `    rows = [{key: _${p}_cell(record, key) for key in fields} for record in records]`,
    '    with open(output_path, "w", newline="", encoding="utf-8") as f:',
    '        writer = csv.DictWriter(f, fieldnames=fields)',
    '        writer.writeheader()',
    '        writer.writerows(rows)',
    '    return rows'
  )
  return L
}

/** The whole marked block for a box (LF line ends). `main`: add an `if __name__ == "__main__":` that runs every request. */
export function generateBlock(box: ApiBox, opts: { main: boolean }): string {
  const p = pyName(box.name)
  const fns = requestFunctions(box)
  const imports = ['csv', 'json', 'os', 'urllib.parse', 'urllib.request']
  if (box.auth.kind === 'basic') imports.unshift('base64')
  const L: string[] = [
    `# forge:box ${box.id} (generated, edit in Forge or here)`,
    ...imports.map((m) => `import ${m}`),
    '',
    '',
    ...helperCode(box, p)
  ]
  for (const req of box.requests) L.push('', '', ...functionCode(box, req, fns.get(req.id)!, p))
  if (opts.main) {
    L.push('', '', 'if __name__ == "__main__":')
    for (const req of box.requests) L.push(`    ${fns.get(req.id)}(${urlArgs(req.url).map((a) => s(req.testArgs[a] ?? '')).join(', ')})`)
  }
  L.push(`# forge:end ${box.id}`)
  return L.join('\n') + '\n'
}

/** FNV-1a (32-bit, hex) of the block, ignoring line endings: detects hand edits. */
export function blockHash(text: string): string {
  let h = 0x811c9dc5
  const t = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
