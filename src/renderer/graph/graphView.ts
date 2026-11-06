/**
 * The Project Graph: how the project fits together (the Graph panel of the Connect task).
 * Modules and their imports (or functions and their calls), laid out by
 * layout.ts and drawn as SVG by hand. Drag to pan, wheel to zoom, hover a node
 * to light up what it uses (blue) and what uses it (orange), click for details
 * on the right, double-click to open the code. With nothing selected, the
 * right side lists the findings: import cycles, possibly unused functions,
 * routes, web APIs called, environment variables.
 */
import type { ProjectGraph } from '../../shared/projectGraph'
import { layoutGraph, type Layout } from './layout'
import { buildView, neighbourhood, type GraphViewData, type ViewNode, type ViewOptions } from './viewModel'

export interface GraphHooks {
  /** Analyse the project (again). */
  scan(): Promise<{ graph?: ProjectGraph; error?: string }>
  /** Open a module's file (relative path) at a 0-based line. */
  openModule(path: string, line: number): void
}

const SVG = 'http://www.w3.org/2000/svg'
const NODE_H = 40
const CHAR_W = 7.2
const SMALL_W = 6.2

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** A stable colour per group (top-level package). */
function groupColour(group: string): string {
  if (!group) return 'var(--fg-muted)'
  let h = 0
  for (const ch of group) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 55% 58%)`
}

export class GraphView {
  readonly el: HTMLDivElement
  private readonly svgEl: SVGSVGElement
  private readonly world: SVGGElement
  private readonly side: HTMLDivElement
  private readonly note: HTMLDivElement
  private readonly search: HTMLInputElement
  private readonly modeButtons: Record<'modules' | 'calls', HTMLButtonElement>
  private readonly focusChip: HTMLButtonElement
  private readonly status: HTMLSpanElement
  private graph: ProjectGraph | null = null
  private loading = false
  private opts: ViewOptions = { mode: 'modules', focus: null, showExternal: false, showTests: false, showHosts: true, query: '' }
  private data: GraphViewData = { nodes: [], edges: [] }
  private layout: Layout | null = null
  private nodeEls = new Map<string, SVGGElement>()
  private edgeEls: { from: string; to: string; el: SVGPathElement }[] = []
  private selected: string | null = null
  private hovered: string | null = null
  /** Pan and zoom. */
  private view = { x: 0, y: 0, k: 1 }

  constructor(private readonly hooks: GraphHooks) {
    this.el = el('div', 'graph-view')
    this.el.tabIndex = -1
    this.el.setAttribute('role', 'region')
    this.el.setAttribute('aria-label', 'Project graph')

    // ----- toolbar -----
    const bar = el('div', 'graph-toolbar')
    const title = el('span', 'graph-title', 'Project Graph')
    const seg = el('div', 'graph-seg')
    const modeButton = (mode: 'modules' | 'calls', label: string, tip: string) => {
      const b = el('button', '', label)
      b.title = tip
      b.addEventListener('click', () => this.setOptions({ mode }))
      seg.append(b)
      return b
    }
    this.modeButtons = {
      modules: modeButton('modules', 'Modules', 'Files and the imports between them'),
      calls: modeButton('calls', 'Calls', 'Functions and the calls between them')
    }
    this.focusChip = el('button', 'graph-chip')
    this.focusChip.title = 'Show the whole project instead'
    this.focusChip.addEventListener('click', () => this.setOptions({ focus: null }))
    this.search = el('input', 'graph-search')
    this.search.placeholder = 'Filter by name ( / )'
    this.search.spellcheck = false
    this.search.addEventListener('input', () => this.setOptions({ query: this.search.value }))
    const toggle = (label: string, tip: string, key: 'showTests' | 'showExternal' | 'showHosts') => {
      const wrap = el('label', 'graph-toggle')
      wrap.title = tip
      const box = el('input')
      box.type = 'checkbox'
      box.checked = this.opts[key]
      box.addEventListener('change', () => this.setOptions({ [key]: box.checked }))
      wrap.append(box, document.createTextNode(label))
      return wrap
    }
    const button = (label: string, tip: string, fn: () => void) => {
      const b = el('button', 'graph-button', label)
      b.title = tip
      b.addEventListener('click', fn)
      return b
    }
    this.status = el('span', 'graph-status')
    bar.append(
      title, seg, this.focusChip, this.search,
      toggle('Tests', 'Show test files', 'showTests'),
      toggle('Packages', 'Show the packages each module imports (standard library and installed)', 'showExternal'),
      toggle('Web APIs', 'Show the web addresses the code calls (requests, httpx, aiohttp)', 'showHosts'),
      this.status,
      button('Fit', 'Fit the graph in view (F)', () => this.fit()),
      button('⟳', 'Analyse the project again', () => void this.refresh()),
    )

    // ----- canvas + side -----
    const body = el('div', 'graph-body')
    const canvas = el('div', 'graph-canvas')
    this.svgEl = svg('svg', {}, 'graph-svg')
    const defs = svg('defs')
    for (const [id, cls] of [['g-arrow', 'arrow'], ['g-arrow-cyc', 'arrow cyc'], ['g-arrow-out', 'arrow out'], ['g-arrow-in', 'arrow in']]) {
      const m = svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
      m.append(svg('path', { d: 'M0,1 L9,5 L0,9 z' }, cls))
      defs.append(m)
    }
    this.world = svg('g')
    this.svgEl.append(defs, this.world)
    this.note = el('div', 'graph-note')
    canvas.append(this.svgEl, this.note)
    this.side = el('div', 'graph-side')
    body.append(canvas, this.side)
    this.el.append(bar, body)

    this.wireCanvas(canvas)
    this.el.addEventListener('keydown', (e) => this.onKey(e))
    this.updateToolbar()
  }

  /** Forget everything (another folder was opened). */
  reset(): void {
    this.graph = null
    this.selected = null
    this.opts = { ...this.opts, focus: null, query: '' }
    this.search.value = ''
    this.world.replaceChildren()
    this.side.replaceChildren()
  }

  /** Analyse the project and redraw. */
  async refresh(): Promise<void> {
    if (this.loading) return
    this.loading = true
    const first = !this.graph
    this.status.textContent = 'Analysing…'
    if (!this.graph) this.showNote('Analysing the project…')
    try {
      const res = await this.hooks.scan()
      if (res.error || !res.graph) {
        this.showNote(`Couldn't analyse the project: ${res.error ?? 'no result'}`)
        this.status.textContent = ''
        return
      }
      this.graph = res.graph
      // Keeps the selection if it still exists, and the pan/zoom unless it's the first time.
      this.render(first)
      const g = res.graph
      this.status.textContent = `${g.modules.length} modules · ${g.modules.reduce((n, m) => n + m.symbols.length, 0)} functions & classes${g.truncated ? ' · first 3000 files only' : ''}`
    } finally {
      this.loading = false
    }
  }

  private setOptions(change: Partial<ViewOptions>): void {
    const modeChanged = change.mode !== undefined && change.mode !== this.opts.mode
    const focusChanged = change.focus !== undefined && change.focus !== this.opts.focus
    this.opts = { ...this.opts, ...change }
    this.updateToolbar()
    this.render(modeChanged || focusChanged || change.query !== undefined || 'showTests' in change || 'showExternal' in change || 'showHosts' in change)
  }

  private updateToolbar(): void {
    this.modeButtons.modules.classList.toggle('active', this.opts.mode === 'modules')
    this.modeButtons.calls.classList.toggle('active', this.opts.mode === 'calls')
    const showChip = this.opts.mode === 'calls' && !!this.opts.focus
    this.focusChip.hidden = !showChip
    this.focusChip.textContent = showChip ? `in ${this.opts.focus} ✕` : ''
  }

  private showNote(text: string | null): void {
    this.note.hidden = !text
    this.note.textContent = text ?? ''
  }

  // ---------- drawing ----------

  private render(fit: boolean): void {
    if (!this.graph) return
    this.data = buildView(this.graph, this.opts)
    if (this.selected && !this.data.nodes.some((n) => n.id === this.selected)) this.selected = null
    this.showNote(this.data.note ?? null)
    const sizes = this.data.nodes.map((n) => ({
      id: n.id,
      width: Math.ceil(Math.max(90, (n.label.length + (n.entry || n.error ? 2 : 0)) * CHAR_W, n.detail.length * SMALL_W) + 26),
      height: NODE_H
    }))
    this.layout = layoutGraph(sizes, this.data.edges, { gapX: 80, gapY: 16 })
    this.draw()
    if (fit) this.fit()
    this.applyHighlight()
    this.renderSide()
  }

  private draw(): void {
    const layout = this.layout!
    const edgeLayer = svg('g', {}, 'graph-edges')
    const nodeLayer = svg('g', {}, 'graph-nodes')
    this.nodeEls.clear()
    this.edgeEls = []
    for (const e of this.data.edges) {
      const a = layout.nodes.get(e.from)
      const b = layout.nodes.get(e.to)
      if (!a || !b) continue
      const x1 = a.x + a.width
      const y1 = a.y + a.height / 2
      const x2 = b.x
      const y2 = b.y + b.height / 2
      // Forward edges curve gently; edges going back (cycles) swing out and around.
      const bend = x2 > x1 ? Math.max(30, (x2 - x1) / 2) : 70 + Math.abs(y2 - y1) / 4
      const path = svg('path', { d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`, 'marker-end': `url(#${e.cyclic ? 'g-arrow-cyc' : 'g-arrow'})` },
        `gedge k-${e.kind}${e.cyclic ? ' cyc' : ''}`)
      edgeLayer.append(path)
      this.edgeEls.push({ from: e.from, to: e.to, el: path })
    }
    for (const n of this.data.nodes) {
      const p = layout.nodes.get(n.id)
      if (!p) continue
      const g = svg('g', { transform: `translate(${p.x},${p.y})` }, this.nodeClass(n))
      g.dataset.id = n.id
      const rect = svg('rect', { width: p.width, height: p.height, rx: n.kind === 'external' || n.kind === 'host' ? p.height / 2 : 6 })
      const stripe = svg('rect', { x: 0, y: 0, width: 4, height: p.height, rx: 2 }, 'gstripe')
      stripe.style.fill = groupColour(n.group)
      const label = svg('text', { x: 12, y: 17 }, 'glabel')
      label.textContent = `${n.entry ? '▶ ' : ''}${n.error ? '⚠ ' : ''}${n.label}`
      const detail = svg('text', { x: 12, y: 32 }, 'gdetail')
      detail.textContent = n.detail
      const tip = svg('title')
      tip.textContent = this.tooltip(n)
      g.append(rect, n.kind === 'external' || n.kind === 'host' ? svg('g') : stripe, label, detail, tip)
      nodeLayer.append(g)
      this.nodeEls.set(n.id, g)
    }
    this.world.replaceChildren(edgeLayer, nodeLayer)
  }

  private nodeClass(n: ViewNode): string {
    return ['gnode', `k-${n.kind}`, n.cyclic ? 'cyc' : '', n.unused ? 'unused' : '', n.error ? 'err' : '', n.match ? 'match' : '', n.test ? 'test' : '']
      .filter(Boolean).join(' ')
  }

  private tooltip(n: ViewNode): string {
    const lines = [n.label, n.detail]
    if (n.entry) lines.push('Runs as a program (if __name__ == "__main__")')
    if (n.cyclic) lines.push('Part of an import cycle')
    if (n.unused) lines.push('Nothing in the project seems to use it')
    if (n.module) lines.push('Double-click to open')
    return lines.join('\n')
  }

  /** Light up the hovered (or selected) node, what it uses and what uses it. */
  private applyHighlight(): void {
    const focus = this.hovered ?? this.selected
    this.svgEl.classList.toggle('hl', !!focus)
    for (const [id, g] of this.nodeEls) g.classList.remove('focus', 'out', 'in', 'selected')
    for (const e of this.edgeEls) e.el.classList.remove('out', 'in')
    if (this.selected) this.nodeEls.get(this.selected)?.classList.add('selected')
    for (const e of this.edgeEls) {
      e.el.setAttribute('marker-end', `url(#${e.el.classList.contains('cyc') ? 'g-arrow-cyc' : 'g-arrow'})`)
    }
    if (!focus) return
    const nb = neighbourhood(this.data.edges, focus)
    this.nodeEls.get(focus)?.classList.add('focus')
    for (const id of nb.out) this.nodeEls.get(id)?.classList.add('out')
    for (const id of nb.in) this.nodeEls.get(id)?.classList.add('in')
    for (const e of this.edgeEls) {
      if (e.from === focus) {
        e.el.classList.add('out')
        e.el.setAttribute('marker-end', 'url(#g-arrow-out)')
      } else if (e.to === focus) {
        e.el.classList.add('in')
        e.el.setAttribute('marker-end', 'url(#g-arrow-in)')
      }
    }
  }

  // ---------- pan, zoom, pointer ----------

  private applyView(): void {
    this.world.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`)
  }

  /** Fit the whole graph in view (not bigger than 100%). */
  fit(): void {
    const layout = this.layout
    const box = this.svgEl.getBoundingClientRect()
    if (!layout || !layout.width || !box.width) {
      this.view = { x: 20, y: 20, k: 1 }
      return this.applyView()
    }
    const pad = 30
    const k = Math.min(1, (box.width - pad * 2) / layout.width, (box.height - pad * 2) / layout.height)
    this.view = { k: Math.max(0.05, k), x: (box.width - layout.width * k) / 2, y: Math.max(pad, (box.height - layout.height * k) / 2) }
    this.applyView()
  }

  private wireCanvas(canvas: HTMLDivElement): void {
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null
    const nodeAt = (target: EventTarget | null) => (target as Element | null)?.closest?.('.gnode') as SVGGElement | null
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false }
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x
        const dy = e.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
        if (drag.moved) {
          this.view.x = drag.vx + dx
          this.view.y = drag.vy + dy
          this.applyView()
          canvas.classList.add('panning')
        }
        return
      }
      const id = nodeAt(e.target)?.dataset.id ?? null
      if (id !== this.hovered) {
        this.hovered = id
        this.applyHighlight()
      }
    })
    canvas.addEventListener('pointerup', (e) => {
      const wasDrag = drag?.moved
      drag = null
      canvas.classList.remove('panning')
      if (wasDrag) return
      // A click (not a drag): select the node under the pointer, or nothing.
      const target = document.elementFromPoint(e.clientX, e.clientY)
      this.select(nodeAt(target)?.dataset.id ?? null)
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.hovered) {
        this.hovered = null
        this.applyHighlight()
      }
    })
    canvas.addEventListener('dblclick', (e) => {
      const id = nodeAt(document.elementFromPoint(e.clientX, e.clientY))?.dataset.id
      if (id) this.open(id)
    })
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const box = this.svgEl.getBoundingClientRect()
      const px = e.clientX - box.left
      const py = e.clientY - box.top
      const k = Math.min(3, Math.max(0.05, this.view.k * Math.pow(1.0015, -e.deltaY)))
      // Zoom around the pointer.
      this.view.x = px - ((px - this.view.x) * k) / this.view.k
      this.view.y = py - ((py - this.view.y) * k) / this.view.k
      this.view.k = k
      this.applyView()
    }, { passive: false })
  }

  private onKey(e: KeyboardEvent): void {
    const typing = e.target === this.search
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      if (typing && this.search.value) {
        this.search.value = ''
        this.setOptions({ query: '' })
      } else if (this.selected) this.select(null)
      return
    }
    if (typing) return
    if (e.key === '/' || (e.key === 'f' && e.ctrlKey)) {
      e.preventDefault()
      this.search.focus()
      this.search.select()
    } else if (e.key === 'f' || e.key === 'F') {
      this.fit()
    }
  }

  // ---------- selection and the side panel ----------

  private select(id: string | null): void {
    this.selected = id
    this.applyHighlight()
    this.renderSide()
  }

  /** Select a node and bring it into view. */
  private reveal(id: string): void {
    const p = this.layout?.nodes.get(id)
    if (!p) return
    const box = this.svgEl.getBoundingClientRect()
    this.view.k = Math.max(this.view.k, 0.8)
    this.view.x = box.width / 2 - (p.x + p.width / 2) * this.view.k
    this.view.y = box.height / 2 - (p.y + p.height / 2) * this.view.k
    this.applyView()
    this.select(id)
  }

  private open(id: string): void {
    const n = this.data.nodes.find((x) => x.id === id)
    const m = n?.module ? this.graph?.modules.find((x) => x.id === n.module) : undefined
    if (n && m) this.hooks.openModule(m.path, n.line ?? 0)
  }

  private openAt(module: string, line: number): void {
    const m = this.graph?.modules.find((x) => x.id === module)
    if (m) this.hooks.openModule(m.path, Math.max(0, line))
  }

  private renderSide(): void {
    const g = this.graph
    if (!g) return this.side.replaceChildren()
    const n = this.selected ? this.data.nodes.find((x) => x.id === this.selected) : undefined
    this.side.replaceChildren(...(n ? this.details(g, n) : this.findings(g)))
  }

  private section(title: string, items: HTMLElement[], empty?: string): HTMLElement[] {
    if (!items.length && !empty) return []
    const head = el('div', 'graph-side-head', `${title}${items.length ? ` (${items.length})` : ''}`)
    return [head, ...(items.length ? items : [el('div', 'graph-side-empty', empty)])]
  }

  private item(text: string, detail: string, onClick: () => void, cls = ''): HTMLElement {
    const row = el('div', `graph-item ${cls}`.trim())
    row.append(el('span', 'graph-item-text', text), el('span', 'graph-item-detail', detail))
    row.title = `${text}${detail ? `  ${detail}` : ''}`
    row.addEventListener('click', onClick)
    return row
  }

  private findings(g: ProjectGraph): HTMLElement[] {
    const functions = g.modules.reduce((n, m) => n + m.symbols.length, 0)
    const intro = el('div', 'graph-side-intro')
    intro.textContent = `${g.modules.length} modules, ${functions} functions and classes, ${g.imports.length} imports between them. Click a node for details, double-click to open it.`
    const short = (module: string, func: string | null) => (func ? `${module}.${func}` : module)
    return [
      intro,
      ...this.section('Import cycles', g.cycles.map((c) => this.item(c.join(' ⇄ '), '', () => this.revealModule(c[0]), 'warn')), 'None: no modules import each other in a loop.'),
      ...this.section('Possibly unused', g.unused.map((s) => this.item(`${s.module}.${s.qual}`, `${s.kind}, line ${s.line}`, () => this.openAt(s.module, s.line - 1))),
        'Every function and class is used somewhere.'),
      ...this.section('Web routes', g.routes.map((r) => this.item(`${r.methods.join(' ')} ${r.path}`, short(r.module, r.func), () => this.openAt(r.module, r.line - 1)))),
      ...this.section('Web APIs called', g.http.map((h) => this.item(`${h.method} ${h.url ?? '(address built at run time)'}`, `${h.library} · ${short(h.module, h.func)}`, () => this.openAt(h.module, h.line - 1)))),
      ...this.section('Environment variables', g.env.map((e) => this.item(e.name, e.uses.map((u) => short(u.module, u.func)).join(', ') + (e.uses.every((u) => u.default) ? ' · has a default' : ''),
        () => this.openAt(e.uses[0].module, e.uses[0].line - 1)))),
      ...this.section('Files that could not be read', g.errors.map((x) => this.item(x.path, x.error, () => this.openAt(x.module, 0), 'warn')))
    ]
  }

  private revealModule(module: string): void {
    if (this.opts.mode !== 'modules' || !this.data.nodes.some((n) => n.id === module)) {
      this.setOptions({ mode: 'modules', focus: null, query: '', showTests: this.opts.showTests || !!this.graph?.modules.find((m) => m.id === module)?.isTest })
      this.search.value = ''
    }
    this.reveal(module)
  }

  private details(g: ProjectGraph, n: ViewNode): HTMLElement[] {
    const head = el('div', 'graph-side-title', n.label)
    const sub = el('div', 'graph-side-sub', n.detail)
    const actions = el('div', 'graph-side-actions')
    const action = (label: string, fn: () => void) => {
      const b = el('button', 'graph-button', label)
      b.addEventListener('click', fn)
      actions.append(b)
    }
    if (n.module) action('Open', () => this.open(n.id))
    const out: HTMLElement[] = [head, sub, actions]
    const nb = neighbourhood(this.data.edges, n.id)
    const label = (id: string) => this.data.nodes.find((x) => x.id === id)?.label ?? id
    const links = (ids: Set<string>) => [...ids].sort().map((id) => this.item(label(id), '', () => this.reveal(id)))

    if (n.kind === 'module') {
      const m = g.modules.find((x) => x.id === n.id)!
      action('Show its calls', () => this.setOptions({ mode: 'calls', focus: m.id, query: '' }))
      sub.textContent = `${m.path} · ${n.detail}`
      if (m.error) out.push(el('div', 'graph-side-warn', m.error))
      if (n.cyclic) {
        const cycle = g.cycles.find((c) => c.includes(m.id))!
        out.push(el('div', 'graph-side-warn', `Import cycle: ${cycle.join(' ⇄ ')}`))
      }
      out.push(
        ...this.section('Imports', links(nb.out)),
        ...this.section('Imported by', links(nb.in)),
        ...this.section('Functions and classes', m.symbols.filter((s) => !s.qual.includes('.') || s.kind === 'method').map((s) =>
          this.item(s.qual, `${s.kind}, line ${s.line}`, () => this.openAt(m.id, s.line - 1), g.unused.some((u) => u.id === s.id) ? 'dim' : ''))),
        ...this.section('Routes', m.routes.map((r) => this.item(`${r.methods.join(' ')} ${r.path}`, r.func, () => this.openAt(m.id, r.line - 1)))),
        ...this.section('Web APIs called', m.http.map((h) => this.item(`${h.method} ${h.url ?? '(built at run time)'}`, h.library, () => this.openAt(m.id, h.line - 1)))),
        ...this.section('Environment variables', m.env.map((e) => this.item(e.name, `line ${e.line}`, () => this.openAt(m.id, e.line - 1))))
      )
    } else if (n.kind === 'external' || n.kind === 'host') {
      out.push(...this.section(n.kind === 'host' ? 'Called from' : 'Imported by', links(nb.in)))
      if (n.kind === 'host') {
        const host = n.id.slice(5)
        out.push(...this.section('Requests', g.http.filter((h) => h.host === host).map((h) =>
          this.item(`${h.method} ${h.url}`, `${h.module}${h.func ? '.' + h.func : ''}`, () => this.openAt(h.module, h.line - 1)))))
      }
    } else {
      if (n.unused) out.push(el('div', 'graph-side-warn', 'Nothing in the project seems to use this (it may still be used dynamically, or from outside).'))
      out.push(...this.section('Calls', links(nb.out)), ...this.section('Called by', links(nb.in)))
    }
    return out
  }
}
