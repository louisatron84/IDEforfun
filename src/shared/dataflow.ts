/**
 * Data flow inside one function: what src/main/dataflow.py read (its
 * parameters and its body as steps), turned into a graph: each step is a
 * node, and a wire runs from the step (or parameter) where a value was last
 * set to every step that uses it. That's where each variable comes from, and
 * what depends on what.
 */

export interface RawArg {
  kw: string | null
  text: string
  names: string[]
}
export interface RawStep {
  line: number
  endLine: number
  kind: 'assign' | 'call' | 'return' | 'for' | 'if' | 'while' | 'with' | 'try' | 'def' | 'other'
  code: string
  targets: string[]
  uses: string[]
  call: { name: string; args: RawArg[] } | null
  loop?: { targets: string[]; over: string }
  body?: RawStep[]
}
export interface RawParam {
  name: string
  annotation: string | null
  default: string | null
}
export interface RawFlow {
  functions: { qual: string; line: number; endLine: number }[]
  error?: string
  func?: string
  line?: number
  endLine?: number
  params?: RawParam[]
  returns?: string | null
  doc?: string
  steps?: RawStep[]
}

export interface FlowNode {
  /** `param:x` for a parameter, `s<line>` for a step. */
  id: string
  kind: RawStep['kind'] | 'param'
  label: string
  line: number
  endLine: number
  /** Variables it sets. */
  sets: string[]
  /** The step it's inside (a for / if / with...), if any. */
  parent: string | null
  call: RawStep['call']
  step?: RawStep
}
export interface FlowEdge {
  from: string
  to: string
  /** The variable carried. */
  name: string
}
export interface Flow {
  func: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** For each node, where each variable it uses comes from (node id), at that point. */
  origins: Map<string, Map<string, string>>
}

export function buildFlow(raw: RawFlow): Flow | null {
  if (!raw.func || !raw.steps) return null
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const origins = new Map<string, Map<string, string>>()
  const last = new Map<string, string>()
  for (const p of raw.params ?? []) {
    if (p.name === 'self' || p.name === 'cls') continue
    const id = `param:${p.name}`
    nodes.push({ id, kind: 'param', label: p.annotation ? `${p.name}: ${p.annotation}` : p.name, line: raw.line ?? 0, endLine: raw.line ?? 0, sets: [p.name], parent: null, call: null })
    last.set(p.name, id)
  }
  const visit = (steps: RawStep[], parent: string | null) => {
    for (const s of steps) {
      let id = `s${s.line}`
      for (let k = 2; nodes.some((n) => n.id === id); k++) id = `s${s.line}_${k}`
      nodes.push({ id, kind: s.kind, label: s.code, line: s.line, endLine: s.endLine, sets: s.targets, parent, call: s.call, step: s })
      const from = new Map<string, string>()
      for (const name of s.uses) {
        const origin = last.get(name)
        if (!origin) continue
        from.set(name, origin)
        if (!edges.some((e) => e.from === origin && e.to === id && e.name === name)) edges.push({ from: origin, to: id, name })
      }
      origins.set(id, from)
      // A loop's variables are set by the loop itself, before its body runs.
      if (s.loop) for (const t of s.loop.targets) last.set(t, id)
      if (s.body) visit(s.body, id)
      for (const t of s.targets) last.set(t, id)
    }
  }
  visit(raw.steps, null)
  return { func: raw.func, nodes, edges, origins }
}

/** Every node that the given node's data reaches (downstream), or that it depends on (upstream). */
export function dependencies(flow: Flow, id: string, direction: 'down' | 'up'): Set<string> {
  const out = new Set<string>()
  const todo = [id]
  while (todo.length) {
    const cur = todo.pop()!
    for (const e of flow.edges) {
      const next = direction === 'down' ? (e.from === cur ? e.to : null) : e.to === cur ? e.from : null
      if (next && !out.has(next)) {
        out.add(next)
        todo.push(next)
      }
    }
  }
  return out
}
