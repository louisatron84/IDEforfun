/**
 * The Graph while debugging: which node each stack frame is in, and a trail
 * of the pauses in this debug session (the stack, the paused function's
 * variables, the calls seen between functions), for the live call graph,
 * the variable history, and comparing two pauses.
 */
import type { ProjectGraph } from '../../shared/projectGraph'

export interface FrameLike {
  path: string | null
  /** 0-based. */
  line: number
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const windowsLike = (p: string) => /^[a-z]:\//i.test(p)

/** The graph node a stack frame is in: the innermost function/class around its line, or the module's top-level code. */
export function frameNode(frame: FrameLike, graph: ProjectGraph, root: string): string | null {
  if (!frame.path) return null
  const file = norm(frame.path)
  const base = norm(root) + '/'
  const fold = windowsLike(file) || windowsLike(base)
  const f = fold ? file.toLowerCase() : file
  const b = fold ? base.toLowerCase() : base
  if (!f.startsWith(b)) return null
  const rel = f.slice(b.length)
  const m = graph.modules.find((x) => (fold ? x.path.toLowerCase() : x.path) === rel)
  if (!m) return null
  const line = frame.line + 1
  let best: { id: string; span: number } | null = null
  for (const s of m.symbols) {
    if (line < s.line || line > s.endLine) continue
    const span = s.endLine - s.line
    if (!best || span < best.span) best = { id: s.id, span }
  }
  return best?.id ?? `module:${m.id}`
}

export type Vars = Record<string, string>

export function diffVars(a: Vars, b: Vars): { added: string[]; removed: string[]; changed: string[]; same: string[] } {
  const out = { added: [] as string[], removed: [] as string[], changed: [] as string[], same: [] as string[] }
  for (const k of Object.keys(a)) {
    if (!(k in b)) out.removed.push(k)
    else if (a[k] === b[k]) out.same.push(k)
    else out.changed.push(k)
  }
  for (const k of Object.keys(b)) if (!(k in a)) out.added.push(k)
  return out
}

export interface Stop {
  /** 1, 2, 3... in this debug session. */
  n: number
  reason: string
  /** Graph nodes of the stack, innermost first (frames outside the project left out). */
  stack: string[]
  /** The paused function's local variables (name → shown value). */
  vars: Vars
  /** Calls (caller → callee) on this stack not seen at any earlier pause. */
  newEdges: [string, string][]
}

const MAX_STOPS = 200

export class DebugTrail {
  private list: Stop[] = []
  private counter = 0
  private readonly edgeCounts = new Map<string, { from: string; to: string; n: number }>()

  get stops(): readonly Stop[] {
    return this.list
  }

  stop(n: number): Stop | undefined {
    return this.list.find((s) => s.n === n)
  }

  get last(): Stop | undefined {
    return this.list[this.list.length - 1]
  }

  addStop(input: { reason: string; stack: (string | null)[]; vars: Vars }): Stop {
    const stack = input.stack.filter((x): x is string => x !== null)
    const newEdges: [string, string][] = []
    for (let i = stack.length - 1; i > 0; i--) {
      const from = stack[i]
      const to = stack[i - 1]
      if (from === to) continue
      const key = `${from}→${to}`
      const e = this.edgeCounts.get(key)
      if (e) e.n++
      else {
        this.edgeCounts.set(key, { from, to, n: 1 })
        newEdges.push([from, to])
      }
    }
    const stop: Stop = { n: ++this.counter, reason: input.reason, stack, vars: { ...input.vars }, newEdges }
    this.list.push(stop)
    if (this.list.length > MAX_STOPS) this.list = this.list.slice(-MAX_STOPS)
    return stop
  }

  /** Every call seen on a stack this session, with how many pauses it was on. */
  edges(): [string, string, number][] {
    return [...this.edgeCounts.values()].map((e) => [e.from, e.to, e.n])
  }

  /** A function's variables at each pause in it (stops where it was the innermost frame). */
  history(node: string): { stops: number[]; rows: { name: string; values: (string | null)[]; changed: boolean[] }[] } {
    const here = this.list.filter((s) => s.stack[0] === node)
    const names: string[] = []
    for (const s of here) for (const k of Object.keys(s.vars)) if (!names.includes(k)) names.push(k)
    return {
      stops: here.map((s) => s.n),
      rows: names.map((name) => {
        const values = here.map((s) => (name in s.vars ? s.vars[name] : null))
        return { name, values, changed: values.map((v, i) => i > 0 && v !== values[i - 1]) }
      })
    }
  }
}
