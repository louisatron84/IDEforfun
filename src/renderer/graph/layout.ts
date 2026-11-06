/**
 * A layered graph layout ("Sugiyama style", kept simple), drawn left to right:
 *   1. loops are broken by turning back-edges around (found with a DFS),
 *   2. each node goes in a column by its longest path from a start node, so
 *      everything a node points to is to its right,
 *   3. nodes in each column are ordered by the average position of their
 *      neighbours (a few sweeps both ways) to reduce crossings,
 *   4. rows are spaced out, then nudged toward their neighbours without
 *      overlapping,
 *   5. nodes with no edges at all go in a grid below.
 * Pure: sizes in, positions out (unit-tested without a DOM).
 */

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutEdge {
  from: string
  to: string
}

export interface Placed {
  x: number
  y: number
  width: number
  height: number
  layer: number
}

export interface Layout {
  nodes: Map<string, Placed>
  width: number
  height: number
}

export interface LayoutOptions {
  /** Space between columns. */
  gapX?: number
  /** Space between nodes in a column. */
  gapY?: number
  sweeps?: number
}

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: LayoutOptions = {}): Layout {
  const gapX = opts.gapX ?? 90
  const gapY = opts.gapY ?? 18
  const sweeps = opts.sweeps ?? 6
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ids = nodes.map((n) => n.id)

  // Edges between known nodes, once each, no self-loops.
  const seen = new Set<string>()
  const list: LayoutEdge[] = []
  for (const e of edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue
    const k = `${e.from}\u0000${e.to}`
    if (!seen.has(k)) {
      seen.add(k)
      list.push(e)
    }
  }
  const connected = new Set(list.flatMap((e) => [e.from, e.to]))

  // 1. Turn back-edges around so the graph has no loops (iterative DFS).
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of list) out.get(e.from)!.push(e.to)
  const state = new Map<string, 1 | 2>() // 1 = on the DFS path, 2 = done
  const forward: LayoutEdge[] = []
  // Start from nodes nothing points to, so the "main" direction is kept.
  const hasIn = new Set(list.map((e) => e.to))
  const starts = [...ids.filter((id) => !hasIn.has(id)), ...ids]
  for (const s of starts) {
    if (state.has(s)) continue
    const stack: { id: string; i: number }[] = [{ id: s, i: 0 }]
    state.set(s, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const next = out.get(top.id)!
      if (top.i < next.length) {
        const w = next[top.i++]
        const st = state.get(w)
        if (st === 1) forward.push({ from: w, to: top.id }) // back-edge: reversed
        else {
          forward.push({ from: top.id, to: w })
          if (st === undefined) {
            state.set(w, 1)
            stack.push({ id: w, i: 0 })
          }
        }
        continue
      }
      state.set(top.id, 2)
      stack.pop()
    }
  }

  // 2. Columns: longest path from the starts (in topological order).
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]))
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]))
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const e of forward) {
    succ.get(e.from)!.push(e.to)
    pred.get(e.to)!.push(e.from)
    indeg.set(e.to, indeg.get(e.to)! + 1)
  }
  const layer = new Map<string, number>()
  const queue = ids.filter((id) => connected.has(id) && indeg.get(id) === 0)
  for (const id of queue) layer.set(id, 0)
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi]
    for (const w of succ.get(id)!) {
      layer.set(w, Math.max(layer.get(w) ?? 0, layer.get(id)! + 1))
      indeg.set(w, indeg.get(w)! - 1)
      if (indeg.get(w) === 0) queue.push(w)
    }
  }
  const layerCount = Math.max(0, ...[...layer.values()].map((l) => l + 1))
  const columns: string[][] = Array.from({ length: layerCount }, () => [])
  for (const id of ids) if (layer.has(id)) columns[layer.get(id)!].push(id)

  // 3. Order within columns by neighbour barycenters.
  const rank = new Map<string, number>()
  const setRanks = () => columns.forEach((col) => col.forEach((id, i) => rank.set(id, i / Math.max(1, col.length - 1))))
  setRanks()
  const neighbours = (id: string, dir: 'pred' | 'succ' | 'both') =>
    dir === 'pred' ? pred.get(id)! : dir === 'succ' ? succ.get(id)! : [...pred.get(id)!, ...succ.get(id)!]
  const reorder = (col: string[], dir: 'pred' | 'succ' | 'both') => {
    const bary = new Map<string, number>()
    col.forEach((id, i) => {
      const ns = neighbours(id, dir)
      bary.set(id, ns.length ? ns.reduce((s, n) => s + rank.get(n)!, 0) / ns.length : i / Math.max(1, col.length - 1))
    })
    col.sort((a, b) => bary.get(a)! - bary.get(b)!)
    col.forEach((id, i) => rank.set(id, i / Math.max(1, col.length - 1)))
  }
  for (let s = 0; s < sweeps; s++) {
    if (s % 2 === 0) for (let l = 1; l < columns.length; l++) reorder(columns[l], 'pred')
    else for (let l = columns.length - 2; l >= 0; l--) reorder(columns[l], 'succ')
  }

  // 4. Coordinates. Columns are as wide as their widest node.
  const colX: number[] = []
  let x = 0
  for (const col of columns) {
    colX.push(x)
    x += Math.max(0, ...col.map((id) => byId.get(id)!.width)) + gapX
  }
  const placed = new Map<string, Placed>()
  const colHeight = (col: string[]) => col.reduce((h, id) => h + byId.get(id)!.height, 0) + gapY * Math.max(0, col.length - 1)
  const tallest = Math.max(0, ...columns.map(colHeight))
  columns.forEach((col, l) => {
    let y = (tallest - colHeight(col)) / 2
    for (const id of col) {
      const n = byId.get(id)!
      placed.set(id, { x: colX[l], y, width: n.width, height: n.height, layer: l })
      y += n.height + gapY
    }
  })
  // Nudge toward neighbours (centre to centre), keeping order and gaps.
  const centre = (id: string) => placed.get(id)!.y + placed.get(id)!.height / 2
  for (let pass = 0; pass < 4; pass++) {
    for (const col of columns) {
      const want = col.map((id) => {
        const ns = neighbours(id, 'both')
        return ns.length ? ns.reduce((s, n) => s + centre(n), 0) / ns.length - placed.get(id)!.height / 2 : placed.get(id)!.y
      })
      // Forward: no overlap with the one above; backward: no overlap with the one below.
      const ys = want.slice()
      for (let i = 1; i < col.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + placed.get(col[i - 1])!.height + gapY)
      for (let i = col.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - placed.get(col[i])!.height - gapY)
      col.forEach((id, i) => (placed.get(id)!.y = ys[i]))
    }
  }

  // Shift so everything starts at (0, 0).
  let minY = Infinity
  for (const p of placed.values()) minY = Math.min(minY, p.y)
  if (minY !== Infinity) for (const p of placed.values()) p.y -= minY
  let height = 0
  let width = Math.max(0, x - gapX)
  for (const p of placed.values()) height = Math.max(height, p.y + p.height)

  // 5. Nodes without edges: a grid below.
  const loose = ids.filter((id) => !connected.has(id))
  if (loose.length) {
    const top = placed.size ? height + gapY * 3 : 0
    const cellW = Math.max(...loose.map((id) => byId.get(id)!.width)) + gapY
    const cellH = Math.max(...loose.map((id) => byId.get(id)!.height)) + gapY
    const perRow = Math.max(1, Math.floor(Math.max(width, cellW * Math.ceil(Math.sqrt(loose.length))) / cellW))
    loose.forEach((id, i) => {
      const n = byId.get(id)!
      placed.set(id, { x: (i % perRow) * cellW, y: top + Math.floor(i / perRow) * cellH, width: n.width, height: n.height, layer: -1 })
    })
    width = Math.max(width, Math.min(loose.length, perRow) * cellW - gapY)
    height = top + Math.ceil(loose.length / perRow) * cellH - gapY
  }
  return { nodes: placed, width, height }
}
