/**
 * Writes a Python client for an OpenAPI description (see ./openapi.ts):
 * standard library only, a dataclass per model, a function per endpoint.
 * The first line marks it as generated, with a hash of the rest, so Forge can
 * tell later whether it was edited by hand (and ask before regenerating).
 */
import { blockHash } from './boxCode'
import type { ApiSpec, Model, Operation, TypeRef } from './openapi'

const MARK = '# forge:openapi'

export function pyType(t: TypeRef): string {
  switch (t.kind) {
    case 'str': return 'str'
    case 'int': return 'int'
    case 'float': return 'float'
    case 'bool': return 'bool'
    case 'any': return 'Any'
    case 'list': return `list[${pyType(t.of)}]`
    case 'dict': return `dict[str, ${pyType(t.of)}]`
    case 'model': return t.name
  }
}

const q = (s: string) => JSON.stringify(s)
/** A docstring-safe line. */
const doc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"').replace(/\s+/g, ' ').trim()

/** Python that turns JSON `expr` into type `t` (models via from_dict, lists of models item by item). */
function fromJson(t: TypeRef, expr: string): string {
  if (t.kind === 'model') return `${t.name}.from_dict(${expr}) if isinstance(${expr}, dict) else ${expr}`
  if (t.kind === 'list' && t.of.kind === 'model') return `[${t.of.name}.from_dict(x) if isinstance(x, dict) else x for x in (${expr} or [])]`
  return expr
}

function modelCode(m: Model): string[] {
  const L: string[] = ['', '', '@dataclass', `class ${m.name}:`]
  L.push(`    """${doc(m.description) || `The ${m.name} object.`}"""`, '')
  const ordered = [...m.fields.filter((f) => f.required), ...m.fields.filter((f) => !f.required)]
  for (const f of ordered) {
    const type = pyType(f.type)
    const comment = f.description ? `  # ${doc(f.description).slice(0, 80)}` : ''
    L.push(f.required ? `    ${f.py}: ${type}${comment}` : `    ${f.py}: Optional[${type}] = None${comment}`)
  }
  if (!ordered.length) L.push('    pass')
  L.push('', '    @classmethod', `    def from_dict(cls, data: dict) -> "${m.name}":`)
  if (!ordered.length) L.push('        return cls()')
  else {
    L.push('        return cls(')
    for (const f of ordered) L.push(`            ${f.py}=${fromJson(f.type, `data.get(${q(f.name)})`)},`)
    L.push('        )')
  }
  L.push('', '    def to_dict(self) -> dict:')
  L.push('        out = {}')
  for (const f of ordered) L.push(`        if self.${f.py} is not None:`, `            out[${q(f.name)}] = _plain(self.${f.py})`)
  L.push('        return out')
  return L
}

function operationCode(op: Operation): string[] {
  const path = op.params.filter((p) => p.in === 'path')
  const required = op.params.filter((p) => p.in !== 'path' && p.required)
  const optional = op.params.filter((p) => p.in !== 'path' && !p.required)
  const sig: string[] = []
  for (const p of [...path, ...required]) sig.push(`${p.py}: ${pyType(p.type)}`)
  if (op.body?.required) sig.push(`body: ${pyType(op.body.type)}`)
  for (const p of optional) sig.push(`${p.py}: Optional[${pyType(p.type)}] = None`)
  if (op.body && !op.body.required) sig.push(`body: Optional[${pyType(op.body.type)}] = None`)
  const ret = op.response ? pyType(op.response) : 'Any'
  const L: string[] = ['', '', `def ${op.id}(${sig.join(', ')}) -> ${ret}:`]
  L.push(`    """${op.method} ${doc(op.path)}${op.summary ? `: ${doc(op.summary)}` : ''}"""`)
  const pathExpr = path.length
    ? `_path(${q(op.path)}, {${path.map((p) => `${q(p.name)}: ${p.py}`).join(', ')}})`
    : q(op.path)
  const query = op.params.filter((p) => p.in === 'query')
  const headers = op.params.filter((p) => p.in === 'header')
  const args = [q(op.method), pathExpr]
  if (query.length) args.push(`params={${query.map((p) => `${q(p.name)}: ${p.py}`).join(', ')}}`)
  if (headers.length) args.push(`headers={${headers.map((p) => `${q(p.name)}: ${p.py}`).join(', ')}}`)
  if (op.body) args.push('body=body')
  if (op.body?.form) args.push('form=True')
  L.push(`    data = _request(${args.join(', ')})`)
  L.push(`    return ${op.response ? fromJson(op.response, 'data') : 'data'}`)
  return L
}

function authCode(spec: ApiSpec): string[] {
  const L: string[] = ['', '', 'def _auth(headers: dict, query: dict) -> None:', '    """Add the credentials from the environment (or .env), when they are set."""']
  if (!spec.auth.length) L.push('    pass')
  for (const a of spec.auth) {
    if (a.kind === 'apiKey') {
      L.push(`    key = os.environ.get(${q(a.env)})`, '    if key:')
      if (a.in === 'query') L.push(`        query[${q(a.name)}] = key`)
      else if (a.in === 'cookie') L.push(`        headers["Cookie"] = ${q(a.name + '=')} + key`)
      else L.push(`        headers[${q(a.name)}] = key`)
    } else if (a.kind === 'bearer') {
      L.push(`    token = os.environ.get(${q(a.env)})`, '    if token:', '        headers["Authorization"] = "Bearer " + token')
    } else {
      L.push(`    user = os.environ.get(${q(a.userEnv)})`, '    if user:',
        `        pair = (user + ":" + os.environ.get(${q(a.passEnv)}, "")).encode("utf-8")`,
        '        headers["Authorization"] = "Basic " + base64.b64encode(pair).decode("ascii")')
    }
  }
  return L
}

/** The client module, for the chosen operations (all when `only` is omitted). */
export function generateClient(spec: ApiSpec, only?: ReadonlySet<string>): string {
  const ops = spec.operations.filter((o) => !only || only.has(o.id))
  // Only the models the chosen operations reach (and what those models reach).
  const byName = new Map(spec.models.map((m) => [m.name, m]))
  const needed = new Set<string>()
  const reach = (t: TypeRef | null | undefined) => {
    if (!t) return
    if (t.kind === 'list' || t.kind === 'dict') return reach(t.of)
    if (t.kind !== 'model' || needed.has(t.name)) return
    needed.add(t.name)
    for (const f of byName.get(t.name)?.fields ?? []) reach(f.type)
  }
  for (const o of ops) {
    reach(o.response)
    reach(o.body?.type)
    for (const p of o.params) reach(p.type)
  }
  const models = spec.models.filter((m) => needed.has(m.name))
  const base = `${spec.envPrefix}_BASE_URL`
  const L: string[] = [
    '"""',
    `Client for ${doc(spec.title)}${spec.version ? ` ${doc(spec.version)}` : ''}, generated by Forge from its OpenAPI description.`,
    '',
    `Settings come from the environment (Forge loads .env): ${base}${spec.auth.length ? ' and the credentials below' : ''}.`,
    'It is ordinary Python: edit it freely. Forge notices edits and asks before regenerating over them.',
    '"""',
    'from __future__ import annotations',
    '',
    'import base64',
    'import json',
    'import os',
    'import urllib.parse',
    'import urllib.request',
    'from dataclasses import dataclass',
    'from typing import Any, Optional',
    '',
    `BASE_URL = os.environ.get(${q(base)}, ${q(spec.baseUrl)})`,
    ...authCode(spec),
    '',
    '',
    'def _plain(value: Any) -> Any:',
    '    """Models and lists of them as plain JSON values."""',
    '    if hasattr(value, "to_dict"):',
    '        return value.to_dict()',
    '    if isinstance(value, list):',
    '        return [_plain(v) for v in value]',
    '    if isinstance(value, dict):',
    '        return {k: _plain(v) for k, v in value.items()}',
    '    return value',
    '',
    '',
    'def _path(template: str, values: dict) -> str:',
    '    return template.format_map({k: urllib.parse.quote(str(v), safe="") for k, v in values.items()})',
    '',
    '',
    'def _request(method: str, path: str, params: Optional[dict] = None, headers: Optional[dict] = None, body: Any = None, form: bool = False) -> Any:',
    '    query = {k: v for k, v in (params or {}).items() if v is not None}',
    '    sent = {"Accept": "application/json"}',
    '    sent.update({k: str(v) for k, v in (headers or {}).items() if v is not None})',
    '    _auth(sent, query)',
    '    url = BASE_URL.rstrip("/") + path',
    '    if query:',
    '        url += "?" + urllib.parse.urlencode(query, doseq=True)',
    '    data = None',
    '    if body is not None:',
    '        if form:',
    '            data = urllib.parse.urlencode(_plain(body), doseq=True).encode("utf-8")',
    '            sent["Content-Type"] = "application/x-www-form-urlencoded"',
    '        else:',
    '            data = json.dumps(_plain(body)).encode("utf-8")',
    '            sent["Content-Type"] = "application/json"',
    '    request = urllib.request.Request(url, data=data, headers=sent, method=method)',
    '    with urllib.request.urlopen(request, timeout=30) as response:',
    '        raw = response.read()',
    '    if not raw:',
    '        return None',
    '    try:',
    '        return json.loads(raw)',
    '    except ValueError:',
    '        return raw.decode("utf-8", "replace")'
  ]
  for (const m of models) L.push(...modelCode(m))
  for (const o of ops) L.push(...operationCode(o))
  const bodyText = L.join('\n') + '\n'
  return `${MARK} ${spec.slug} ${blockHash(bodyText)}\n${bodyText}`
}

/** For a file Forge generated: which API, and whether it was edited since. null if it isn't one. */
export function generatedState(text: string): { slug: string; edited: boolean } | null {
  const t = text.replace(/\r\n/g, '\n')
  const nl = t.indexOf('\n')
  const first = nl < 0 ? t : t.slice(0, nl)
  const m = /^# forge:openapi (\S+) ([0-9a-f]{8})$/.exec(first)
  if (!m) return null
  return { slug: m[1], edited: blockHash(t.slice(nl + 1)) !== m[2] }
}

/** `from api.github_client import get_user, list_repos`, for the functions you'll call. */
export function importLine(modulePath: string, names: readonly string[]): string {
  const mod = modulePath.replace(/\\/g, '/').replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.')
  return `from ${mod} import ${names.join(', ')}`
}

/** Add an import line after a file's existing imports (or its docstring), unless it's there already. */
export function addImport(text: string, line: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.some((l) => l.trim() === line)) return text
  let at = 0
  let i = 0
  // Skip a module docstring.
  if (/^\s*[rubRUB]?("""|''')/.test(lines[0] ?? '')) {
    const quote = /("""|''')/.exec(lines[0])![1]
    const rest = lines[0].slice(lines[0].indexOf(quote) + 3)
    i = rest.includes(quote) ? 1 : lines.findIndex((l, k) => k > 0 && l.includes(quote)) + 1
    at = i
  }
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (/^(import|from)\s/.test(l)) at = i + 1
    else if (l.trim() && !l.startsWith('#') && !/^\s/.test(l) && at > 0) break
  }
  lines.splice(at, 0, line)
  return lines.join(eol)
}
