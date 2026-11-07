/**
 * The project graph: what src/main/projectScan.py found in every Python file,
 * turned into modules and the imports between them, functions and the calls
 * between them, plus findings (import cycles, functions nothing seems to use,
 * web routes, outgoing HTTP calls, environment variables).
 *
 * Everything is static: names are resolved the way Python would at import
 * time where that's clear (local defs, imports, module.attr, self.method,
 * Class().method); anything dynamic is left unresolved rather than guessed.
 */

// ---------- what the scan script prints ----------

export interface RawImport { module: string; names: string[]; alias: string | null; level: number; line: number }
export interface RawCall { name: string; line: number }
export interface RawParamSig { name: string; annotation: string | null; default: string | null }
export interface RawDef {
  name: string
  /** Dotted path inside the module: "Client.get"; "<module>" for top-level code. */
  qual: string
  kind: 'module' | 'class' | 'function' | 'method'
  line: number
  endLine: number
  calls: RawCall[]
  /** Names (and attribute names) the code reads. */
  refs: string[]
  decorators: string[]
  /** Functions: the parameters (name, annotation and default as written), return annotation and first docstring line. */
  params?: RawParamSig[]
  returns?: string | null
  doc?: string
  bases?: string[]
}
export interface RawRoute { methods: string[]; path: string; func: string; line: number; framework: string; owner: string | null }
export interface RawHttp { library: string; method: string; url: string | null; line: number; func: string | null }
export interface RawEnv { name: string; line: number; func: string | null; default: boolean }
/**
 * Statements that can never run. `reason`: what stops the code before them
 * (return, raise, break, continue, 'branches' when every branch of an
 * if/else or try stops, 'constant' for `if False:` and the like).
 */
export interface RawUnreachable { line: number; endLine: number; func: string | null; reason: 'return' | 'raise' | 'break' | 'continue' | 'branches' | 'constant' }
export interface RawFile {
  /** Relative to the project, with / separators. */
  path: string
  module: string
  isPackage: boolean
  imports: RawImport[]
  defs: RawDef[]
  routes: RawRoute[]
  http: RawHttp[]
  env: RawEnv[]
  /** Missing from scans by older versions of the script. */
  unreachable?: RawUnreachable[]
  lines: number
  error?: string
  all?: string[]
  /** Has an `if __name__ == "__main__":` block. */
  main?: boolean
  /** A client Forge generated (from an OpenAPI description), and whether it was edited by hand since. */
  generated?: { kind: 'openapi'; slug: string; edited: boolean }
}
export interface RawScan { root: string; python: string; truncated: boolean; files: RawFile[] }

// ---------- the graph ----------

export interface SymbolNode {
  /** "module:qual" */
  id: string
  module: string
  qual: string
  name: string
  kind: 'class' | 'function' | 'method'
  line: number
  endLine: number
  decorators: string[]
  /** Functions: the parameters (name, annotation and default as written), return annotation and first docstring line. */
  params?: RawParamSig[]
  returns?: string | null
  doc?: string
}

export interface ModuleNode {
  /** The dotted module name ("app.service"); "" can't happen (files at the root have their own name). */
  id: string
  path: string
  isPackage: boolean
  isTest: boolean
  /** Runs as a program (`if __name__ == "__main__":`). */
  isEntry: boolean
  generated?: RawFile['generated']
  lines: number
  error?: string
  symbols: SymbolNode[]
  routes: RawRoute[]
  http: RawHttp[]
  env: RawEnv[]
}

export interface ImportEdge {
  from: string
  to: string
  line: number
  /** Part of an import cycle. */
  cyclic: boolean
}

export interface CallEdge {
  /** A symbol id, or "module:<module>" for top-level code. */
  from: string
  to: string
  line: number
}

export interface HttpUse extends RawHttp {
  module: string
  /** "api.github.com", or null when the URL isn't written out in the code. */
  host: string | null
}

export interface ProjectGraph {
  modules: ModuleNode[]
  imports: ImportEdge[]
  /** Third-party / standard-library packages and the modules importing them. */
  externals: { name: string; importedBy: string[] }[]
  calls: CallEdge[]
  /** Groups of modules that import each other (directly or in a loop). */
  cycles: string[][]
  /** Functions, methods and classes nothing in the project seems to use. */
  unused: SymbolNode[]
  /** Code that can never run, by module then line. */
  unreachable: (RawUnreachable & { module: string })[]
  routes: (RawRoute & { module: string })[]
  http: HttpUse[]
  env: { name: string; uses: { module: string; line: number; func: string | null; default: boolean }[] }[]
  errors: { module: string; path: string; error: string }[]
  truncated: boolean
}

/** "lines 13–14, after a return": where some unreachable code is and why it can't run. */
export function describeUnreachable(u: RawUnreachable): string {
  const where = u.line === u.endLine ? `line ${u.line}` : `lines ${u.line}–${u.endLine}`
  const why = {
    return: 'after a return',
    raise: 'after a raise',
    break: 'after a break',
    continue: 'after a continue',
    branches: 'every branch above it stops',
    constant: 'its condition is always false'
  }[u.reason]
  return `${where}, ${why}`
}

export const isTestPath = (path: string): boolean =>
  /(^|\/)(tests?|testing)\//.test(path) || /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(path)

export function hostOf(url: string | null): string | null {
  if (!url) return null
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#{…]+)/i.exec(url)
  return m ? m[1].replace(/^[^@]*@/, '').toLowerCase() : null
}

/** Methods frameworks and Python itself call (never reported as unused). */
const HOOK_METHODS = new Set(['setUp', 'tearDown', 'setUpClass', 'tearDownClass', 'run', 'main', 'handle', 'get', 'post', 'put', 'patch', 'delete', 'dispatch', 'save', 'clean', 'validate'])

export function buildGraph(scan: RawScan): ProjectGraph {
  const files = new Map(scan.files.map((f) => [f.module, f]))
  const isModule = (name: string) => files.has(name)

  /** The deepest project module that `dotted` starts with, or null. */
  const longestModule = (dotted: string): string | null => {
    const parts = dotted.split('.')
    for (let k = parts.length; k > 0; k--) {
      const name = parts.slice(0, k).join('.')
      if (isModule(name)) return name
    }
    return null
  }

  /** The absolute name `from <level dots><module> import ...` refers to. */
  const absolute = (file: RawFile, imp: RawImport): string => {
    if (!imp.level) return imp.module
    const pkg = file.isPackage ? file.module.split('.') : file.module.split('.').slice(0, -1)
    const base = pkg.slice(0, Math.max(0, pkg.length - (imp.level - 1)))
    return [...base, ...(imp.module ? [imp.module] : [])].filter(Boolean).join('.')
  }

  // ----- modules and symbols -----
  const modules: ModuleNode[] = scan.files.map((f) => ({
    id: f.module,
    path: f.path,
    isPackage: f.isPackage,
    isTest: isTestPath(f.path),
    isEntry: !!f.main,
    ...(f.generated ? { generated: f.generated } : {}),
    lines: f.lines,
    ...(f.error ? { error: f.error } : {}),
    symbols: f.defs.filter((d) => d.kind !== 'module').map((d) => ({
      id: `${f.module}:${d.qual}`, module: f.module, qual: d.qual, name: d.name, kind: d.kind as SymbolNode['kind'],
      line: d.line, endLine: d.endLine, decorators: d.decorators,
      ...(d.params ? { params: d.params, returns: d.returns ?? null, doc: d.doc ?? '' } : {})
    })),
    routes: f.routes,
    http: f.http,
    env: f.env
  }))
  const symbolById = new Map(modules.flatMap((m) => m.symbols.map((s) => [s.id, s] as const)))
  const symbolIn = (module: string, qual: string) => symbolById.get(`${module}:${qual}`)

  // ----- imports, and what each imported name means in its module -----
  type Binding = { module: string } | { symbol: SymbolNode }
  const bindings = new Map<string, Map<string, Binding>>()
  const edges = new Map<string, ImportEdge>()
  const externals = new Map<string, Set<string>>()
  const addEdge = (from: string, to: string, line: number) => {
    if (from === to) return
    const k = `${from}\u0000${to}`
    if (!edges.has(k)) edges.set(k, { from, to, line, cyclic: false })
  }
  const addExternal = (name: string, by: string) => {
    const top = name.split('.')[0]
    if (!top) return
    let set = externals.get(top)
    if (!set) externals.set(top, (set = new Set()))
    set.add(by)
  }
  for (const f of scan.files) {
    const b = new Map<string, Binding>()
    bindings.set(f.module, b)
    for (const imp of f.imports) {
      const base = absolute(f, imp)
      if (!imp.names.length) {
        // import a.b.c [as x]
        const target = longestModule(base)
        if (target) addEdge(f.module, target, imp.line)
        else addExternal(base, f.module)
        if (imp.alias) {
          if (target === base) b.set(imp.alias, { module: target })
        } else {
          const top = base.split('.')[0]
          if (isModule(top)) b.set(top, { module: top })
        }
        continue
      }
      // from base import n1, n2
      let baseUsed = false
      for (const n of imp.names) {
        if (n === '*') {
          baseUsed = true
          continue
        }
        const sub = base ? `${base}.${n}` : n
        if (isModule(sub)) {
          addEdge(f.module, sub, imp.line)
          b.set(n, { module: sub })
        } else {
          baseUsed = true
          const sym = isModule(base) ? symbolIn(base, n) : undefined
          if (sym) b.set(n, { symbol: sym })
        }
      }
      if (baseUsed) {
        const target = longestModule(base)
        if (target) addEdge(f.module, target, imp.line)
        else if (imp.level === 0) addExternal(base, f.module)
      }
    }
  }
  const imports = [...edges.values()]

  // ----- import cycles (strongly connected components, Tarjan) -----
  const cycles = stronglyConnected(modules.map((m) => m.id), imports).filter((c) => c.length > 1)
  const inCycle = new Map<string, number>()
  cycles.forEach((c, i) => c.forEach((m) => inCycle.set(m, i)))
  for (const e of imports) {
    const a = inCycle.get(e.from)
    if (a !== undefined && a === inCycle.get(e.to)) e.cyclic = true
  }

  // ----- calls -----
  const calls: CallEdge[] = []
  const callSeen = new Set<string>()
  for (const f of scan.files) {
    const b = bindings.get(f.module)!
    for (const d of f.defs) {
      const from = d.kind === 'module' ? `module:${f.module}` : `${f.module}:${d.qual}`
      for (const c of d.calls) {
        const target = resolveCall(c.name, f, d, b, symbolIn, isModule)
        if (!target || target.id === from) continue
        const k = `${from}\u0000${target.id}`
        if (callSeen.has(k)) continue
        callSeen.add(k)
        calls.push({ from, to: target.id, line: c.line })
      }
    }
  }

  // ----- possibly unused: never named anywhere else in the project -----
  const referencedBy = new Map<string, Set<string>>()
  for (const f of scan.files) {
    for (const d of f.defs) for (const r of d.refs) {
      let set = referencedBy.get(r)
      if (!set) referencedBy.set(r, (set = new Set()))
      set.add(`${f.module}:${d.qual}`)
    }
  }
  const unused: SymbolNode[] = []
  for (const m of modules) {
    if (m.isTest) continue
    const file = files.get(m.id)!
    const exported = new Set(file.all ?? [])
    const classBases = new Map(file.defs.filter((d) => d.kind === 'class').map((d) => [d.qual, d.bases ?? []]))
    const routed = new Set(m.routes.map((r) => r.func))
    for (const s of m.symbols) {
      if (s.name.startsWith('__') || exported.has(s.name) || routed.has(s.qual) || s.name.startsWith('test')) continue
      if (s.decorators.some((dec) => !['staticmethod', 'classmethod'].includes(dec))) continue
      if (s.kind === 'method') {
        const cls = s.qual.slice(0, s.qual.lastIndexOf('.'))
        // A subclass's methods may be called by its base class (or a framework).
        if ((classBases.get(cls)?.length ?? 0) > 0 || HOOK_METHODS.has(s.name)) continue
      }
      if (s.name === 'main') continue
      // Used if some other code (not itself or code nested in it) names it.
      const users = [...(referencedBy.get(s.name) ?? [])].filter((u) => u !== s.id && !u.startsWith(s.id + '.'))
      if (!users.length) unused.push(s)
    }
  }

  // ----- findings across the project -----
  const routes = modules.flatMap((m) => m.routes.map((r) => ({ ...r, module: m.id })))
  const http = modules.flatMap((m) => m.http.map((h) => ({ ...h, module: m.id, host: hostOf(h.url) })))
  const envMap = new Map<string, ProjectGraph['env'][number]['uses']>()
  for (const m of modules) for (const e of m.env) {
    let uses = envMap.get(e.name)
    if (!uses) envMap.set(e.name, (uses = []))
    uses.push({ module: m.id, line: e.line, func: e.func, default: e.default })
  }

  return {
    modules,
    imports,
    externals: [...externals].map(([name, by]) => ({ name, importedBy: [...by].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    calls,
    cycles,
    unused,
    unreachable: scan.files.flatMap((f) => (f.unreachable ?? []).map((u) => ({ ...u, module: f.module }))).sort((a, b) => a.module.localeCompare(b.module) || a.line - b.line),
    routes,
    http,
    env: [...envMap].map(([name, uses]) => ({ name, uses })).sort((a, b) => a.name.localeCompare(b.name)),
    errors: modules.filter((m) => m.error).map((m) => ({ module: m.id, path: m.path, error: m.error! })),
    truncated: scan.truncated
  }
}

/** What a call like `foo()`, `mod.foo()`, `self.bar()` or `Client().get()` refers to, if it's clear. */
function resolveCall(
  name: string,
  file: RawFile,
  def: RawDef,
  b: Map<string, { module: string } | { symbol: SymbolNode }>,
  symbolIn: (module: string, qual: string) => SymbolNode | undefined,
  isModule: (name: string) => boolean
): SymbolNode | undefined {
  const parts = name.split('.')
  const mod = file.module
  // Class().method -> method of that class
  const instance = parts[0].endsWith('()') ? parts[0].slice(0, -2) : null
  if (instance !== null && parts.length === 2 && !instance.includes('(')) {
    const cls = resolveCall(instance, file, def, b, symbolIn, isModule)
    return cls?.kind === 'class' ? symbolIn(cls.module, `${cls.qual}.${parts[1]}`) : undefined
  }
  if (parts.some((p) => p.includes('('))) return undefined
  if (parts.length === 1) {
    // A function nested in this one, a top-level def, or an imported name.
    if (def.kind !== 'module') {
      const nested = symbolIn(mod, `${def.qual}.${name}`)
      if (nested) return nested
    }
    const local = symbolIn(mod, name)
    if (local) return local
    const bound = b.get(name)
    return bound && 'symbol' in bound ? bound.symbol : undefined
  }
  if ((parts[0] === 'self' || parts[0] === 'cls') && parts.length === 2 && def.kind === 'method') {
    const cls = def.qual.slice(0, def.qual.lastIndexOf('.'))
    return symbolIn(mod, `${cls}.${parts[1]}`)
  }
  const head = b.get(parts[0])
  // Class.method (a local or imported class)
  const cls = symbolIn(mod, parts[0]) ?? (head && 'symbol' in head ? head.symbol : undefined)
  if (cls?.kind === 'class' && parts.length === 2) return symbolIn(cls.module, `${cls.qual}.${parts[1]}`)
  if (!head || !('module' in head)) return undefined
  // module.sub.func / module.Class.method: walk down submodules as far as they go.
  let target = head.module
  let i = 1
  while (i < parts.length - 1 && isModule(`${target}.${parts[i]}`)) target = `${target}.${parts[i++]}`
  const rest = parts.slice(i).join('.')
  return symbolIn(target, rest)
}

/** Strongly connected components of the import graph (Tarjan), each sorted by name. */
export function stronglyConnected(nodes: readonly string[], edges: readonly { from: string; to: string }[]): string[][] {
  const out = new Map<string, string[]>()
  for (const n of nodes) out.set(n, [])
  for (const e of edges) out.get(e.from)?.push(e.to)
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []
  // Iterative, so a long import chain can't overflow the call stack.
  for (const start of nodes) {
    if (idx.has(start)) continue
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }]
    idx.set(start, index)
    low.set(start, index++)
    stack.push(start)
    onStack.add(start)
    while (work.length) {
      const top = work[work.length - 1]
      const succ = out.get(top.node) ?? []
      if (top.next < succ.length) {
        const w = succ[top.next++]
        if (!out.has(w)) continue
        if (!idx.has(w)) {
          idx.set(w, index)
          low.set(w, index++)
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, next: 0 })
        } else if (onStack.has(w)) {
          low.set(top.node, Math.min(low.get(top.node)!, idx.get(w)!))
        }
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!))
      }
      if (low.get(top.node) === idx.get(top.node)) {
        const comp: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          comp.push(w)
        } while (w !== top.node)
        result.push(comp.sort())
      }
    }
  }
  return result
}

/**
 * A file that can't be read right now (a syntax error while typing) keeps what
 * the last good scan found in it, so the outline panels don't go blank: the
 * error is still reported.
 */
export function keepLastGood(next: RawScan, prev: RawScan | null): RawScan {
  if (!prev) return next
  const before = new Map(prev.files.map((f) => [f.path, f]))
  return {
    ...next,
    files: next.files.map((f) => {
      const old = before.get(f.path)
      if (!f.error || !old || old.error || !/SyntaxError/.test(f.error)) return f
      return { ...old, error: f.error, lines: f.lines || old.lines }
    })
  }
}

/** A scan with some files scanned again (e.g. the one being edited); new files are added. */
export function replaceFiles(scan: RawScan, files: readonly RawFile[]): RawScan {
  const fresh = new Map(files.map((f) => [f.path, f]))
  const kept = scan.files.map((f) => fresh.get(f.path) ?? f)
  const known = new Set(scan.files.map((f) => f.path))
  return { ...scan, files: [...kept, ...files.filter((f) => !known.has(f.path))] }
}
