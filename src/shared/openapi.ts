/**
 * OpenAPI (3.x) and Swagger (2.0) descriptions, read into what Forge needs to
 * write a Python client: the base address, how to authenticate, the
 * endpoints (with their parameters, body and response) and the data models.
 * Anything it can't type is `any` rather than an error.
 */
import { pyName } from './boxes'

export type TypeRef =
  | { kind: 'str' | 'int' | 'float' | 'bool' | 'any' }
  | { kind: 'list'; of: TypeRef }
  | { kind: 'dict'; of: TypeRef }
  | { kind: 'model'; name: string }

export interface Field {
  /** The key in the JSON. */
  name: string
  /** A valid Python name for it. */
  py: string
  type: TypeRef
  required: boolean
  description: string
}

export interface Model {
  /** PascalCase Python class name. */
  name: string
  description: string
  fields: Field[]
}

export interface Param extends Field {
  in: 'path' | 'query' | 'header'
}

export interface Operation {
  /** The Python function name. */
  id: string
  method: string
  path: string
  summary: string
  tag: string
  params: Param[]
  body: { type: TypeRef; required: boolean; form: boolean } | null
  /** The success response's JSON type, or null when it has none. */
  response: TypeRef | null
}

export type AuthScheme =
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string; env: string }
  | { kind: 'bearer'; env: string }
  | { kind: 'basic'; userEnv: string; passEnv: string }

export interface ApiSpec {
  title: string
  version: string
  description: string
  /** May be empty (then the client reads it from the environment only). */
  baseUrl: string
  /** For names: `GitHub API` → `github`. */
  slug: string
  /** Prefix of its environment variables: `GITHUB`. */
  envPrefix: string
  auth: AuthScheme[]
  operations: Operation[]
  models: Model[]
  warnings: string[]
}

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield', 'match', 'case', 'type'
])

/** A Python identifier (snake_case) for any JSON key: `user-id` → `user_id`, `class` → `class_`, `firstName` → `first_name`. */
export function pyIdent(text: string): string {
  const snake = text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  let s = pyName(snake)
  if (s === 'api' && !/api/i.test(text)) s = 'value'
  if (PY_KEYWORDS.has(s)) s += '_'
  return s
}

/** A Python class name: `user-profile` → `UserProfile`. */
export function pyClass(text: string): string {
  const parts = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  let s = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('') || 'Model'
  if (/^[0-9]/.test(s)) s = 'M' + s
  if (PY_KEYWORDS.has(s)) s += '_'
  return s
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** Read a parsed OpenAPI / Swagger document. `from` (the address it came from) resolves a relative server URL. */
export function readSpec(doc: unknown, from = ''): ApiSpec {
  if (!isObj(doc)) throw new Error('This isn\'t an OpenAPI description (expected a JSON or YAML object).')
  const v3 = typeof doc.openapi === 'string'
  const v2 = doc.swagger === '2.0' || doc.swagger === 2
  if (!v3 && !v2) throw new Error('This isn\'t an OpenAPI description: it has neither "openapi" nor "swagger": "2.0" at the top.')
  const warnings: string[] = []
  const info = isObj(doc.info) ? doc.info : {}
  const title = str(info.title, 'API')
  const slug = pyName(title.replace(/\bapi\b/gi, '').trim() || title)
  const envPrefix = slug.replace(/^_+/, '').toUpperCase() || 'API'

  // ----- $ref resolution -----
  const resolve = (v: unknown, depth = 0): unknown => {
    if (!isObj(v) || typeof v.$ref !== 'string' || depth > 20) return v
    const ref = v.$ref
    if (!ref.startsWith('#/')) {
      warnings.push(`Skipped a reference to another file: ${ref}`)
      return {}
    }
    let cur: unknown = doc
    for (const part of ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) cur = isObj(cur) ? cur[part] : undefined
    return resolve(cur ?? {}, depth + 1)
  }
  const schemaRoot = v3 ? (isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {}) : isObj(doc.definitions) ? doc.definitions : {}
  const schemaPrefix = v3 ? '#/components/schemas/' : '#/definitions/'

  // ----- models -----
  const models = new Map<string, Model>()
  const modelNames = new Map<string, string>()
  const usedNames = new Set<string>()
  const nameFor = (key: string) => {
    let n = modelNames.get(key)
    if (n) return n
    n = pyClass(key)
    for (let k = 2; usedNames.has(n); k++) n = `${pyClass(key)}${k}`
    usedNames.add(n)
    modelNames.set(key, n)
    return n
  }
  const typeOf = (raw: unknown, depth = 0): TypeRef => {
    if (depth > 12) return { kind: 'any' }
    if (isObj(raw) && typeof raw.$ref === 'string' && raw.$ref.startsWith(schemaPrefix)) {
      const key = raw.$ref.slice(schemaPrefix.length)
      const target = resolve(raw)
      if (isObj(target) && isObjectSchema(target)) {
        buildModel(key, target)
        return { kind: 'model', name: nameFor(key) }
      }
      return typeOf(target, depth + 1)
    }
    const s = resolve(raw)
    if (!isObj(s)) return { kind: 'any' }
    if (Array.isArray(s.allOf) && s.allOf.length === 1) return typeOf(s.allOf[0], depth + 1)
    if (s.oneOf || s.anyOf) return { kind: 'any' }
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type
    switch (t) {
      case 'string': return { kind: 'str' }
      case 'integer': return { kind: 'int' }
      case 'number': return { kind: 'float' }
      case 'boolean': return { kind: 'bool' }
      case 'array': return { kind: 'list', of: typeOf(s.items, depth + 1) }
      case 'object':
      default:
        if (isObj(s.additionalProperties) && !isObj(s.properties)) return { kind: 'dict', of: typeOf(s.additionalProperties, depth + 1) }
        return t === 'object' || isObj(s.properties) ? { kind: 'dict', of: { kind: 'any' } } : { kind: 'any' }
    }
  }
  const isObjectSchema = (s: Obj) => isObj(s.properties) || (Array.isArray(s.allOf) && s.allOf.length > 1)
  const building = new Set<string>()
  function buildModel(key: string, schema: Obj): void {
    if (models.has(key) || building.has(key)) return
    building.add(key)
    const props: Obj = {}
    const required = new Set<string>()
    const collect = (s: unknown) => {
      const r = resolve(s)
      if (!isObj(r)) return
      if (Array.isArray(r.allOf)) for (const part of r.allOf) collect(part)
      if (isObj(r.properties)) Object.assign(props, r.properties)
      if (Array.isArray(r.required)) for (const q of r.required) if (typeof q === 'string') required.add(q)
    }
    collect(schema)
    const used = new Set<string>()
    const fields: Field[] = Object.entries(props).map(([name, p]) => {
      let py = pyIdent(name)
      for (let k = 2; used.has(py); k++) py = `${pyIdent(name)}_${k}`
      used.add(py)
      return { name, py, type: typeOf(p), required: required.has(name), description: str(resolve(p) && isObj(resolve(p)) ? (resolve(p) as Obj).description : '') }
    })
    models.set(key, { name: nameFor(key), description: str(schema.description), fields })
    building.delete(key)
  }
  for (const [key, s] of Object.entries(schemaRoot)) if (isObj(s) && isObjectSchema(s)) buildModel(key, s)

  // ----- base address -----
  let baseUrl = ''
  if (v3) {
    const server = Array.isArray(doc.servers) && isObj(doc.servers[0]) ? doc.servers[0] : null
    if (server) {
      let url = str(server.url)
      if (isObj(server.variables)) {
        for (const [k, v] of Object.entries(server.variables)) url = url.replace(`{${k}}`, isObj(v) ? str(v.default) : '')
      }
      baseUrl = url
    }
  } else {
    const schemes = Array.isArray(doc.schemes) ? doc.schemes : []
    const scheme = schemes.includes('https') ? 'https' : str(schemes[0], 'https')
    if (typeof doc.host === 'string') baseUrl = `${scheme}://${doc.host}${str(doc.basePath)}`
    else baseUrl = str(doc.basePath)
  }
  if (baseUrl && !/^[a-z]+:\/\//i.test(baseUrl)) {
    if (/^https?:\/\//i.test(from)) {
      try {
        baseUrl = new URL(baseUrl, from).href
      } catch {
        // leave it
      }
    } else warnings.push(`The server address "${baseUrl}" is relative: set ${envPrefix}_BASE_URL to the full address.`)
  }
  baseUrl = baseUrl.replace(/\/+$/, '')

  // ----- authentication -----
  const auth: AuthScheme[] = []
  const schemes = v3 ? (isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {}) : isObj(doc.securityDefinitions) ? doc.securityDefinitions : {}
  for (const raw of Object.values(schemes)) {
    const s = resolve(raw)
    if (!isObj(s)) continue
    if (s.type === 'apiKey' && typeof s.name === 'string') {
      const where = s.in === 'query' || s.in === 'cookie' ? s.in : 'header'
      if (!auth.some((a) => a.kind === 'apiKey')) auth.push({ kind: 'apiKey', in: where, name: s.name, env: `${envPrefix}_API_KEY` })
    } else if ((s.type === 'http' && String(s.scheme).toLowerCase() === 'basic') || s.type === 'basic') {
      if (!auth.some((a) => a.kind === 'basic')) auth.push({ kind: 'basic', userEnv: `${envPrefix}_USERNAME`, passEnv: `${envPrefix}_PASSWORD` })
    } else if (s.type === 'http' || s.type === 'oauth2' || s.type === 'openIdConnect') {
      if (!auth.some((a) => a.kind === 'bearer')) auth.push({ kind: 'bearer', env: `${envPrefix}_TOKEN` })
    }
  }

  // ----- operations -----
  const operations: Operation[] = []
  const usedIds = new Set<string>()
  const paths = isObj(doc.paths) ? doc.paths : {}
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(rawItem)
    if (!isObj(item)) continue
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = item[method]
      if (!isObj(op)) continue
      let id = pyIdent(str(op.operationId) || `${method}_${path.replace(/\{[^}]*\}/g, 'by').replace(/[^a-zA-Z0-9]+/g, '_')}`)
      for (let k = 2; usedIds.has(id); k++) id = `${pyIdent(str(op.operationId) || method + path)}_${k}`
      usedIds.add(id)
      const params: Param[] = []
      let body: Operation['body'] = null
      const usedPy = new Set<string>()
      const formFields: Obj = {}
      const all = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((p) => resolve(p)).filter(isObj)
      // Operation-level parameters override path-level ones with the same name and place.
      const byKey = new Map<string, Obj>()
      for (const p of all) byKey.set(`${str(p.in)}:${str(p.name)}`, p)
      for (const p of byKey.values()) {
        const where = str(p.in)
        if (where === 'body') {
          body = { type: typeOf(p.schema), required: p.required === true, form: false }
          continue
        }
        if (where === 'formData') {
          formFields[str(p.name)] = p
          continue
        }
        if (where !== 'path' && where !== 'query' && where !== 'header') continue
        let py = pyIdent(str(p.name))
        for (let k = 2; usedPy.has(py); k++) py = `${pyIdent(str(p.name))}_${k}`
        usedPy.add(py)
        params.push({
          name: str(p.name), py, in: where, required: where === 'path' || p.required === true,
          type: v3 ? typeOf(p.schema) : typeOf(p), description: str(p.description)
        })
      }
      if (Object.keys(formFields).length) body = { type: { kind: 'dict', of: { kind: 'any' } }, required: true, form: true }
      if (v3 && op.requestBody) {
        const rb = resolve(op.requestBody)
        if (isObj(rb) && isObj(rb.content)) {
          const json = Object.entries(rb.content).find(([ct]) => /json/i.test(ct))
          const form = Object.entries(rb.content).find(([ct]) => /x-www-form-urlencoded/i.test(ct))
          const chosen = json ?? form ?? Object.entries(rb.content)[0]
          const media = chosen && isObj(chosen[1]) ? chosen[1] : {}
          body = { type: typeOf(media.schema), required: rb.required === true, form: !json && !!form }
        }
      }
      // Success response: the first 2xx with a JSON body.
      let response: TypeRef | null = null
      const responses = isObj(op.responses) ? op.responses : {}
      const ok = Object.keys(responses).filter((c) => /^2/.test(c)).sort()[0] ?? (responses.default ? 'default' : undefined)
      if (ok) {
        const r = resolve(responses[ok])
        if (isObj(r)) {
          if (v3 && isObj(r.content)) {
            const json = Object.entries(r.content).find(([ct]) => /json/i.test(ct))
            if (json && isObj(json[1])) response = typeOf(json[1].schema)
          } else if (!v3 && r.schema) response = typeOf(r.schema)
        }
      }
      const tags = Array.isArray(op.tags) ? op.tags : []
      operations.push({
        id, method: method.toUpperCase(), path, summary: str(op.summary) || str(op.description).split('\n')[0],
        tag: str(tags[0], 'other'), params, body, response
      })
    }
  }
  if (!operations.length) warnings.push('No endpoints found in it.')
  return {
    title, version: str(info.version), description: str(info.description).split('\n')[0], baseUrl, slug: slug || 'api', envPrefix, auth,
    operations, models: [...models.values()], warnings: [...new Set(warnings)]
  }
}

/** The environment variables a client for this spec reads. */
export function envKeys(spec: ApiSpec): string[] {
  const keys = [`${spec.envPrefix}_BASE_URL`]
  for (const a of spec.auth) {
    if (a.kind === 'apiKey' || a.kind === 'bearer') keys.push(a.env)
    else keys.push(a.userEnv, a.passEnv)
  }
  return keys
}
