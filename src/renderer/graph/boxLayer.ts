/**
 * Connect boxes on the Graph. A box has no position of its own: it sits just
 * right of the node it belongs to (its module, or in the Calls view its
 * generated function), stacked if several share a node, so it never drifts
 * away from its code when the graph is laid out again.
 */
import type { ApiBox, ApiRequest, FieldNode } from '../../shared/boxes'
import { requestFunctions } from '../../shared/boxCode'
import type { Layout } from './layout'

const SVG = 'http://www.w3.org/2000/svg'
const GAP_X = 24
const GAP_Y = 8
const HEAD = 26
const LINE = 18
const CHAR = 6.3

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}

export interface PlacedBox {
  x: number
  y: number
  width: number
  height: number
  /** The node it is wired to (null: not on the graph yet). */
  anchor: string | null
}

/** The node a box sits beside in this view, if it is shown. */
export function boxAnchor(box: ApiBox, mode: 'modules' | 'calls', nodeIds: ReadonlySet<string>): string | null {
  if (!box.attach) return null
  const module = box.attach.module
  if (mode === 'calls') {
    for (const fn of requestFunctions(box).values()) if (nodeIds.has(`${module}:${fn}`)) return `${module}:${fn}`
  }
  return nodeIds.has(module) ? module : null
}

function leafCount(fields: readonly FieldNode[]): number {
  return fields.reduce((n, f) => n + (f.kind === 'object' ? leafCount(f.children) : 1), 0)
}

/** `GET api.github.com/users → users.csv · 2 of 5 fields` */
export function boxSummary(box: ApiBox, req: ApiRequest): string {
  let where = req.url.trim()
  if (where && !/^https?:\/\//i.test(where) && box.baseUrl.trim()) where = box.baseUrl.trim().replace(/\/+$/, '') + '/' + where.replace(/^\/+/, '')
  where = where.replace(/^https?:\/\//i, '') || '(no URL yet)'
  const fields = req.test?.fields
  const tail = fields?.length ? `${req.ticked.length} of ${leafCount(fields)} fields` : 'not tested'
  return `${req.method} ${where} → ${req.output} · ${tail}`
}

function size(box: ApiBox): { width: number; height: number } {
  const longest = Math.max(box.name.length + 6, ...box.requests.map((r) => boxSummary(box, r).length))
  return { width: Math.round(Math.max(220, Math.min(460, longest * CHAR + 34))), height: HEAD + LINE * box.requests.length + 6 }
}

export function placeBoxes(layout: Layout, boxes: readonly ApiBox[], mode: 'modules' | 'calls', nodeIds: ReadonlySet<string>): Map<string, PlacedBox> {
  const out = new Map<string, PlacedBox>()
  const nextY = new Map<string | null, number>()
  for (const box of boxes) {
    const anchor = boxAnchor(box, mode, nodeIds)
    const node = anchor ? layout.nodes.get(anchor) : undefined
    const key = node ? anchor : null
    const { width, height } = size(box)
    const x = node ? node.x + node.width + GAP_X : layout.width + 60
    const y = nextY.get(key) ?? (node ? node.y : 0)
    out.set(box.id, { x, y, width, height, anchor: node ? anchor : null })
    nextY.set(key, y + height + GAP_Y)
  }
  return out
}

function status(req: ApiRequest): 'untested' | 'ok' | 'fail' {
  return !req.test ? 'untested' : req.test.ok ? 'ok' : 'fail'
}

/** The boxes and their wires, ready to add to the graph's world. */
export function drawBoxLayer(
  layout: Layout,
  placed: ReadonlyMap<string, PlacedBox>,
  boxes: readonly ApiBox[],
  opts: { selected: string | null; live: ReadonlySet<string>; reducedMotion: boolean }
): SVGGElement {
  const layer = svg('g', {}, 'graph-boxes')
  const wires = svg('g')
  const frames = svg('g')
  for (const box of boxes) {
    const p = placed.get(box.id)
    if (!p) continue
    const live = opts.live.has(box.id)
    const a = p.anchor ? layout.nodes.get(p.anchor) : undefined
    if (a) {
      const x1 = a.x + a.width
      const y1 = a.y + a.height / 2
      const x2 = p.x
      const y2 = p.y + HEAD / 2
      const bend = Math.max(12, (x2 - x1) / 2)
      const d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
      wires.append(svg('path', { d }, `gbox-wire${live ? ' live' : ''}`))
      if (live && !opts.reducedMotion) {
        const spark = svg('circle', { r: 3.5 }, 'spark')
        spark.append(svg('animateMotion', { dur: '1.1s', repeatCount: 'indefinite', path: d }))
        wires.append(spark)
      }
    }
    const g = svg('g', { transform: `translate(${p.x},${p.y})` }, `gbox${box.id === opts.selected ? ' selected' : ''}${live ? ' live' : ''}`)
    g.setAttribute('data-box', box.id)
    g.append(svg('rect', { width: p.width, height: p.height }, 'gbox-frame'))
    const title = svg('text', { x: 10, y: 17 }, 'gbox-title')
    title.textContent = `${box.name} · API`
    g.append(title)
    box.requests.forEach((req, i) => {
      const line = svg('g', { transform: `translate(0,${HEAD + i * LINE})` }, 'gbox-line')
      line.append(svg('circle', { cx: 14, cy: 8, r: 3.5 }, `dot ${status(req)}`))
      const t = svg('text', { x: 24, y: 12 })
      t.textContent = boxSummary(box, req)
      line.append(t)
      g.append(line)
    })
    const tip = svg('title')
    tip.textContent = `${box.name}: writes to ${box.target.file}\nClick to edit it in Box settings`
    g.append(tip)
    frames.append(g)
  }
  layer.append(wires, frames)
  return layer
}
