/**
 * Where you are: a small map of the current file's module, with what imports
 * it on the left, what it imports on the right, and the web APIs it calls
 * (dashed). Click a module to open it; double-click to see it in Connect.
 */
import type { ProjectGraph } from '../../shared/projectGraph'
import { layoutGraph } from '../graph/layout'
import { neighbourhood } from './whereModel'

export interface WhereHooks {
  /** Open a module's file. */
  open(module: string): void
  /** Show a module in the Connect task's graph. */
  reveal(module: string): void
}

const SVG = 'http://www.w3.org/2000/svg'
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, cls?: string) => {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}

export class WhereView {
  readonly body: HTMLDivElement
  private readonly note: HTMLDivElement
  private readonly map: SVGSVGElement

  constructor(private readonly hooks: WhereHooks) {
    this.body = document.createElement('div')
    this.body.className = 'where-view'
    this.note = document.createElement('div')
    this.note.className = 'where-note'
    this.map = svg('svg', {}, 'where-map')
    this.body.append(this.note, this.map)
  }

  /** Draw the map for `module` (null: show `message` instead). */
  set(graph: ProjectGraph | null, module: string | null, message: string): void {
    this.map.replaceChildren()
    if (!graph || !module) {
      this.note.textContent = message
      this.note.hidden = false
      return
    }
    this.note.hidden = true
    const n = neighbourhood(graph, module)
    const nodes = [
      { id: n.module, label: n.module.split('.').pop()!, kind: 'me' },
      ...n.importedBy.map((m) => ({ id: m, label: m, kind: 'in' })),
      ...n.imports.map((m) => ({ id: m, label: m, kind: 'out' })),
      ...n.hosts.map((h) => ({ id: `host:${h}`, label: h, kind: 'host' }))
    ]
    const edges = [
      ...n.importedBy.map((m) => ({ from: m, to: n.module })),
      ...n.imports.map((m) => ({ from: n.module, to: m })),
      ...n.hosts.map((h) => ({ from: n.module, to: `host:${h}` }))
    ]
    const layout = layoutGraph(nodes.map((x) => ({ id: x.id, width: Math.max(48, x.label.length * 7 + 16), height: 22 })), edges, { gapX: 36, gapY: 8 })
    const pad = 6
    this.map.setAttribute('viewBox', `${-pad} ${-pad} ${Math.max(layout.width, 60) + pad * 2} ${Math.max(layout.height, 22) + pad * 2}`)
    for (const e of edges) {
      const a = layout.nodes.get(e.from)!
      const b = layout.nodes.get(e.to)!
      const x1 = a.x + a.width
      const y1 = a.y + a.height / 2
      const x2 = b.x
      const y2 = b.y + b.height / 2
      const mid = (x1 + x2) / 2
      this.map.append(svg('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` }, 'where-edge'))
    }
    for (const x of nodes) {
      const p = layout.nodes.get(x.id)!
      const g = svg('g', { transform: `translate(${p.x},${p.y})` }, `where-node k-${x.kind}`)
      g.append(svg('rect', { width: p.width, height: p.height }))
      const t = svg('text', { x: 8, y: 15 })
      t.textContent = x.label
      const title = svg('title', {})
      title.textContent = x.kind === 'host' ? `${x.label} (web API)` : `${x.id}\nClick to open, double-click to see it in Connect`
      g.append(t, title)
      if (x.kind !== 'host') {
        g.addEventListener('click', () => this.hooks.open(x.id))
        g.addEventListener('dblclick', () => this.hooks.reveal(x.id))
      }
      this.map.append(g)
    }
  }
}
