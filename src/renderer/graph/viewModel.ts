/**
 * Which nodes and edges the Project Graph shows, for the chosen view and
 * filters. Pure (tested without a DOM); graphView.ts draws the result.
 *
 * Views:
 *   modules: files and the imports between them (+ packages used, web APIs called)
 *   calls:   functions and the calls between them (of one module, or the whole project)
 */
import type { ProjectGraph } from '../../shared/projectGraph'

export type ViewNodeKind = 'module' | 'external' | 'host' | 'class' | 'function' | 'method' | 'code'

export interface ViewNode {
  id: string
  label: string
  /** Second line (smaller). */
  detail: string
  kind: ViewNodeKind
  /** Nodes in the same group share a colour (the top-level package). */
  group: string
  /** Where it is, to open it. */
  module?: string
  line?: number
  entry?: boolean
  error?: boolean
  test?: boolean
  unused?: boolean
  cyclic?: boolean
  /** Matches the search text. */
  match?: boolean
}

export interface ViewEdge {
  from: string
  to: string
  kind: 'import' | 'external' | 'http' | 'call'
  cyclic?: boolean
}

export interface ViewOptions {
  mode: 'modules' | 'calls'
  /** Calls view: only this module's functions (and what they call / what calls them). */
  focus: string | null
  showExternal: boolean
  showTests: boolean
  showHosts: boolean
  /** Search: keeps matching nodes and their direct neighbours. */
  query: string
}

export interface GraphViewData {
  nodes: ViewNode[]
  edges: ViewEdge[]
  /** Why something isn't shown (too big, nothing found...). */
  note?: string
}

/** Calls view of the whole project is capped (beyond this, pick a module). */
export const MAX_CALL_NODES = 400

const topPackage = (module: string) => module.split('.')[0]

export function buildView(g: ProjectGraph, opts: ViewOptions): GraphViewData {
  const data = opts.mode === 'modules' ? modulesView(g, opts) : callsView(g, opts)
  return applyQuery(data, opts.query)
}

function modulesView(g: ProjectGraph, opts: ViewOptions): GraphViewData {
  const cyclic = new Set(g.cycles.flat())
  const touched = new Set(g.imports.flatMap((e) => [e.from, e.to]))
  const nodes: ViewNode[] = []
  for (const m of g.modules) {
    if (m.isTest && !opts.showTests) continue
    // Empty package files (__init__.py) only add clutter.
    if (m.isPackage && !m.symbols.length && m.lines <= 2 && !touched.has(m.id)) continue
    const bits = [`${m.lines} line${m.lines === 1 ? '' : 's'}`]
    if (m.routes.length) bits.push(`${m.routes.length} route${m.routes.length === 1 ? '' : 's'}`)
    if (m.error) bits.push('could not read')
    nodes.push({
      id: m.id, label: m.id, detail: bits.join(' · '), kind: 'module', group: topPackage(m.id), module: m.id, line: 0,
      entry: m.isEntry, error: !!m.error, test: m.isTest, cyclic: cyclic.has(m.id)
    })
  }
  const shown = new Set(nodes.map((n) => n.id))
  const edges: ViewEdge[] = g.imports
    .filter((e) => shown.has(e.from) && shown.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, kind: 'import', cyclic: e.cyclic }))
  if (opts.showExternal) {
    for (const x of g.externals) {
      const by = x.importedBy.filter((m) => shown.has(m))
      if (!by.length) continue
      nodes.push({ id: `ext:${x.name}`, label: x.name, detail: 'package', kind: 'external', group: '' })
      for (const m of by) edges.push({ from: m, to: `ext:${x.name}`, kind: 'external' })
    }
  }
  if (opts.showHosts) {
    const hosts = new Map<string, Set<string>>()
    for (const h of g.http) {
      if (!h.host || !shown.has(h.module)) continue
      let set = hosts.get(h.host)
      if (!set) hosts.set(h.host, (set = new Set()))
      set.add(h.module)
    }
    for (const [host, mods] of hosts) {
      const methods = new Set(g.http.filter((h) => h.host === host).map((h) => h.method))
      nodes.push({ id: `host:${host}`, label: host, detail: `web API · ${[...methods].sort().join(' ')}`, kind: 'host', group: '' })
      for (const m of mods) edges.push({ from: m, to: `host:${host}`, kind: 'http' })
    }
  }
  return { nodes, edges, ...(nodes.length ? {} : { note: 'No Python modules found in this folder.' }) }
}

function callsView(g: ProjectGraph, opts: ViewOptions): GraphViewData {
  const modules = new Map(g.modules.map((m) => [m.id, m]))
  const symbols = new Map(g.modules.flatMap((m) => m.symbols.map((s) => [s.id, s] as const)))
  const unused = new Set(g.unused.map((s) => s.id))
  const visibleModule = (id: string) => opts.showTests || !modules.get(id)?.isTest
  const moduleOf = (id: string) => (id.startsWith('module:') ? id.slice(7) : id.slice(0, id.indexOf(':')))

  let edges = g.calls.filter((c) => visibleModule(moduleOf(c.from)) && visibleModule(moduleOf(c.to)))
  const ids = new Set<string>()
  if (opts.focus) {
    const own = (id: string) => moduleOf(id) === opts.focus
    edges = edges.filter((c) => own(c.from) || own(c.to))
    for (const s of modules.get(opts.focus)?.symbols ?? []) if (s.kind !== 'class' || edges.some((c) => c.to === s.id)) ids.add(s.id)
  }
  for (const c of edges) {
    ids.add(c.from)
    ids.add(c.to)
  }
  if (!opts.focus && ids.size > MAX_CALL_NODES) {
    return { nodes: [], edges: [], note: `This project has ${ids.size} functions with calls: too many to draw at once. Pick a module (click it in the Modules view, then Calls).` }
  }
  const nodes: ViewNode[] = []
  for (const id of ids) {
    if (id.startsWith('module:')) {
      const m = moduleOf(id)
      nodes.push({ id, label: m, detail: 'top-level code', kind: 'code', group: topPackage(m), module: m, line: 0 })
      continue
    }
    const s = symbols.get(id)
    if (!s) continue
    const local = opts.focus === s.module
    nodes.push({
      id, label: local ? s.qual : `${s.module}.${s.qual}`, detail: `${s.kind} · line ${s.line}`, kind: s.kind,
      group: topPackage(s.module), module: s.module, line: s.line - 1, unused: unused.has(id), test: modules.get(s.module)?.isTest
    })
  }
  const note = !nodes.length
    ? opts.focus ? `No functions or calls found in ${opts.focus}.` : 'No calls between the project\'s functions were found.'
    : undefined
  return { nodes, edges: edges.map((c) => ({ from: c.from, to: c.to, kind: 'call' })), ...(note ? { note } : {}) }
}

/** Search: keep matching nodes plus their direct neighbours (to see what they connect to). */
function applyQuery(data: GraphViewData, query: string): GraphViewData {
  const q = query.trim().toLowerCase()
  if (!q) return data
  const match = new Set(data.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id))
  if (!match.size) return { nodes: [], edges: [], note: `Nothing matches "${query.trim()}".` }
  const keep = new Set(match)
  for (const e of data.edges) {
    if (match.has(e.from)) keep.add(e.to)
    if (match.has(e.to)) keep.add(e.from)
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)).map((n) => (match.has(n.id) ? { ...n, match: true } : n)),
    edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to))
  }
}

/** Direct neighbours of a node: what it uses (out) and what uses it (in). */
export function neighbourhood(edges: readonly ViewEdge[], id: string): { out: Set<string>; in: Set<string> } {
  const out = new Set<string>()
  const inn = new Set<string>()
  for (const e of edges) {
    if (e.from === id) out.add(e.to)
    if (e.to === id) inn.add(e.from)
  }
  return { out, in: inn }
}
