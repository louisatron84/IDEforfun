/**
 * Draws an object graph (see src/shared/objectGraph.ts) as boxes and arrows.
 */
import { layoutGraph } from './layout'
import type { ObjGraph } from '../../shared/objectGraph'

const SVG = 'http://www.w3.org/2000/svg'
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}

/** The objects as boxes (type, simple fields) with arrows for references; variables point in from the left. */
export function drawObjectGraph(g: ObjGraph): SVGSVGElement {
  const CW = 6.6
  const LINE = 15
  const size = new Map<string, { width: number; height: number }>()
  for (const n of g.nodes) {
    const lines = [n.type + (n.len !== undefined ? ` (${n.len})` : ''), ...n.fields.map(([k, v]) => (k ? `${k} = ${v}` : v)), ...(n.more ? [`+${n.more} more`] : [])]
    size.set(n.id, { width: Math.min(320, Math.max(...lines.map((l) => l.length)) * CW + 16), height: lines.length * LINE + 10 })
  }
  const layout = layoutGraph(
    [...g.roots.map(([name]) => ({ id: `var:${name}`, width: name.length * CW + 20, height: 24 })), ...g.nodes.map((n) => ({ id: n.id, ...size.get(n.id)! }))],
    [...g.roots.map(([name, id]) => ({ from: `var:${name}`, to: id })), ...g.edges.map(([a, b]) => ({ from: a, to: b }))],
    { gapX: 70, gapY: 14 }
  )
  const root = svg('svg', { viewBox: `-10 -10 ${layout.width + 20} ${layout.height + 20}` }, 'object-graph')
  const defs = svg('defs')
  const m = svg('marker', { id: 'obj-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
  m.append(svg('path', { d: 'M0,1 L9,5 L0,9 z' }, 'obj-arrowhead'))
  defs.append(m)
  root.append(defs)
  const wires = svg('g')
  const boxes = svg('g')
  const line = (from: string, to: string, label: string) => {
    const a = layout.nodes.get(from)
    const b = layout.nodes.get(to)
    if (!a || !b) return
    const x1 = a.x + a.width
    const y1 = a.y + a.height / 2
    const back = b.x <= a.x
    const x2 = back ? b.x + b.width / 2 : b.x
    const y2 = back ? b.y : b.y + b.height / 2
    const mx = (x1 + x2) / 2
    wires.append(svg('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, 'marker-end': 'url(#obj-arrow)' }, 'obj-wire'))
    if (label) {
      const t = svg('text', { x: mx, y: (y1 + y2) / 2 - 3, 'text-anchor': 'middle' }, 'obj-label')
      t.textContent = label
      wires.append(t)
    }
  }
  for (const [name, id] of g.roots) line(`var:${name}`, id, '')
  for (const [a, b, label] of g.edges) line(a, b, label)
  for (const [name] of g.roots) {
    const p = layout.nodes.get(`var:${name}`)!
    const gEl = svg('g', {}, 'obj-var')
    gEl.append(svg('rect', { x: p.x, y: p.y, width: p.width, height: p.height, rx: 12 }))
    const t = svg('text', { x: p.x + 10, y: p.y + 16 })
    t.textContent = name
    gEl.append(t)
    boxes.append(gEl)
  }
  for (const n of g.nodes) {
    const p = layout.nodes.get(n.id)!
    const gEl = svg('g', {}, 'obj-node')
    gEl.append(svg('rect', { x: p.x, y: p.y, width: p.width, height: p.height, rx: 3 }))
    const lines = [n.type + (n.len !== undefined ? ` (${n.len})` : ''), ...n.fields.map(([k, v]) => (k ? `${k} = ${v}` : v)), ...(n.more ? [`+${n.more} more`] : [])]
    lines.forEach((l, i) => {
      const t = svg('text', { x: p.x + 8, y: p.y + 17 + i * LINE }, i === 0 ? 'obj-type' : 'obj-field')
      t.textContent = l
      gEl.append(t)
    })
    boxes.append(gEl)
  }
  root.append(wires, boxes)
  return root
}
