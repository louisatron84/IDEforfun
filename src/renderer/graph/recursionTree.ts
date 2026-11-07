/**
 * Recursion trees from a traced run (src/main/runTrace.py sends
 * `{"t":"rec","tree":{...}}`): the calls of a function that calls itself,
 * each with its arguments and the value it returned, drawn as a tree.
 */

export interface RecNode {
  /** Index of the call that made this one; -1 for the first call. */
  parent: number
  args: string
  /** null while the call hasn't returned (or if it raised). */
  ret: string | null
}
export interface RecTree {
  key: string
  /** `module:qual` */
  func: string
  nodes: RecNode[]
  /** Every call, including those past the drawing cap. */
  total: number
}

export function parseRec(raw: unknown): RecTree | null {
  const m = raw as { t?: unknown; tree?: unknown } | null
  if (!m || m.t !== 'rec' || !m.tree || typeof m.tree !== 'object') return null
  const t = m.tree as { key?: unknown; func?: unknown; nodes?: unknown; total?: unknown }
  if (typeof t.key !== 'string' || typeof t.func !== 'string' || !Array.isArray(t.nodes) || !t.nodes.length) return null
  const nodes: RecNode[] = []
  for (const [i, n] of t.nodes.entries()) {
    if (!Array.isArray(n) || n.length !== 3 || !Number.isInteger(n[0]) || typeof n[1] !== 'string' || (n[2] !== null && typeof n[2] !== 'string')) return null
    // The first is the root; every other call's parent came before it.
    if (i === 0 ? n[0] !== -1 : n[0] < 0 || n[0] >= i) return null
    nodes.push({ parent: n[0], args: n[1], ret: n[2] })
  }
  return { key: t.key, func: t.func, nodes, total: Number.isInteger(t.total) ? (t.total as number) : nodes.length }
}

/** Positions in grid units: x (leaves 0, 1, 2...; parents centred over their children) and depth. */
export function treeLayout(tree: RecTree): { pos: { x: number; depth: number }[]; columns: number; depth: number } {
  const kids: number[][] = tree.nodes.map(() => [])
  tree.nodes.forEach((n, i) => {
    if (n.parent >= 0) kids[n.parent].push(i)
  })
  const pos = tree.nodes.map(() => ({ x: 0, depth: 0 }))
  let next = 0
  let maxDepth = 0
  // Iterative post-order (deep recursion would overflow a recursive walk).
  const stack: { i: number; depth: number; done: boolean }[] = [{ i: 0, depth: 0, done: false }]
  while (stack.length) {
    const top = stack.pop()!
    pos[top.i].depth = top.depth
    maxDepth = Math.max(maxDepth, top.depth)
    if (!top.done && kids[top.i].length) {
      stack.push({ ...top, done: true })
      for (let k = kids[top.i].length - 1; k >= 0; k--) stack.push({ i: kids[top.i][k], depth: top.depth + 1, done: false })
      continue
    }
    const ks = kids[top.i]
    pos[top.i].x = ks.length ? (pos[ks[0]].x + pos[ks[ks.length - 1]].x) / 2 : next++
  }
  return { pos, columns: next, depth: maxDepth + 1 }
}

/** This run's recursion trees, newest version of each. */
export class RecursionStore {
  private trees = new Map<string, RecTree>()
  private run = 0

  begin(runId: number): void {
    this.run = runId
    this.trees = new Map()
  }

  get runId(): number {
    return this.run
  }

  add(t: RecTree): void {
    this.trees.set(t.key, t)
  }

  forFunc(func: string): RecTree[] {
    return [...this.trees.values()].filter((t) => t.func === func)
  }

  funcs(): string[] {
    return [...new Set([...this.trees.values()].map((t) => t.func))]
  }
}

const SVG = 'http://www.w3.org/2000/svg'
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}

/** The tree as SVG: each call `name(args)` with `→ value` under it. */
export function drawRecursionTree(tree: RecTree, name: string): SVGSVGElement {
  const { pos, columns, depth } = treeLayout(tree)
  const labels = tree.nodes.map((n) => `${name}(${n.args})`)
  const CW = 6.4
  const colW = Math.min(220, Math.max(70, ...labels.map((l) => l.length * CW + 14), ...tree.nodes.map((n) => (n.ret ?? '').length * CW + 24)))
  const rowH = 64
  const boxH = 34
  const root = svg('svg', { viewBox: `0 0 ${columns * colW + 20} ${depth * rowH + 10}` }, 'recursion-tree')
  const wires = svg('g')
  const boxes = svg('g')
  const centre = (i: number) => ({ x: 10 + pos[i].x * colW + colW / 2, y: 6 + pos[i].depth * rowH })
  tree.nodes.forEach((n, i) => {
    const c = centre(i)
    if (n.parent >= 0) {
      const p = centre(n.parent)
      wires.append(svg('path', { d: `M${p.x},${p.y + boxH} C${p.x},${p.y + boxH + 14} ${c.x},${c.y - 14} ${c.x},${c.y}` }, 'rec-wire'))
    }
    const w = colW - 10
    const g = svg('g', {}, `rec-node${n.ret === null ? ' open' : ''}${i === 0 ? ' root' : ''}`)
    g.append(svg('rect', { x: c.x - w / 2, y: c.y, width: w, height: boxH, rx: 3 }))
    const call = svg('text', { x: c.x, y: c.y + 14, 'text-anchor': 'middle' }, 'rec-call')
    call.textContent = labels[i]
    const ret = svg('text', { x: c.x, y: c.y + 28, 'text-anchor': 'middle' }, 'rec-ret')
    ret.textContent = n.ret === null ? '(no value)' : `→ ${n.ret}`
    const title = svg('title')
    title.textContent = `${labels[i]} → ${n.ret ?? 'did not return a value (still running, or raised)'}`
    g.append(title, call, ret)
    boxes.append(g)
  })
  root.append(wires, boxes)
  return root
}
