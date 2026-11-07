/**
 * The Project Graph: how the project fits together (the Graph panel of the Connect task).
 * Modules and their imports (or functions and their calls), laid out by
 * layout.ts and drawn as SVG by hand. Drag to pan, wheel to zoom, hover a node
 * to light up what it uses (blue) and what uses it (orange), click for details
 * on the right, double-click to open the code. With nothing selected, the
 * right side lists the findings: import cycles, possibly unused functions,
 * routes, web APIs called, environment variables.
 */
import { describeUnreachable, type ProjectGraph } from '../../shared/projectGraph'
import { formatMs, heatLevel, slowest, timePath, viewTimes, type RunProfile } from '../../shared/profile'
import { layoutGraph, type Layout } from './layout'
import { buildView, neighbourhood, type GraphViewData, type ViewNode, type ViewOptions } from './viewModel'
import type { ApiBox } from '../../shared/boxes'
import { boxBounds, drawBoxLayer, panToShow, placeBoxes, type PlacedBox } from './boxLayer'
import { BOX_DRAG_TYPE } from '../boxes/toolbox'
import type { NetSpark, RunFrame, RunView } from './liveRun'

/** Connect boxes shown on the graph. */
export interface GraphBoxHooks {
  list(): readonly ApiBox[]
  selected(): string | null
  select(id: string): void
  /** A click on the graph that wasn't on a box. */
  clear(): void
  /** A box was dropped from the Toolbox: on a module (its code goes there), or on empty canvas. */
  drop(module: string | null): void
  /** Boxes whose wire is live (a test call is running). */
  live(): ReadonlySet<string>
}

export interface GraphHooks {
  /** Analyse the project (again). */
  scan(): Promise<{ graph?: ProjectGraph; error?: string }>
  /** Open a module's file (relative path) at a 0-based line. */
  openModule(path: string, line: number): void
  boxes?: GraphBoxHooks
  /** While debugging: a function's variables at each pause (for its details), or null. */
  debugHistory?(node: string): HTMLElement | null
  /** From the last traced run (recursion trees): shown in a node's details, or null. */
  runDetails?(node: string): HTMLElement | null
  /** Open a function's data flow (the Pipeline view). */
  showDataFlow?(node: string): void
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

/** A tracer id for people: `app:load` → "app.load", `module:app` → "app (top level)". */
function timeLabel(id: string): string {
  return id.startsWith('module:') ? `${id.slice(7)} (top level)` : id.replace(':', '.')
}

function describeTime(t: { calls: number; totalMs: number; selfMs: number }): string {
  return `${formatMs(t.totalMs)} in total, ${formatMs(t.selfMs)} in its own code, ${t.calls} call${t.calls === 1 ? '' : 's'}`
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
  private readonly canvas: HTMLDivElement
  /** Replay of the last traced run: ▶, a slider and a speed. */
  private readonly replayBox: HTMLSpanElement
  private replay: { count: number; show(i: number): void; done(): void; timer: number | null; at: number } | null = null
  /** Debugging: the paused node, the stack's nodes, and the variables card beside the paused node. */
  private debugAt: string | null = null
  private debugStack: string[] = []
  private card: HTMLElement | null = null
  /** A panel over the canvas (object relationships, recursion tree). */
  private overlay: HTMLElement | null = null
  private graph: ProjectGraph | null = null
  private loading = false
  private opts: ViewOptions = { mode: 'modules', focus: null, showExternal: false, showTests: false, showHosts: true, query: '' }
  private data: GraphViewData = { nodes: [], edges: [] }
  private layout: Layout | null = null
  private nodeEls = new Map<string, SVGGElement>()
  private edgeEls: { from: string; to: string; el: SVGPathElement }[] = []
  private boxLayer: SVGGElement | null = null
  private placedBoxes: ReadonlyMap<string, PlacedBox> = new Map()
  /** Live run: the node glowing now, the layer sparks fly on, the status text to put back. */
  private runGlow: string | null = null
  private sparkLayer: SVGGElement = svg('g', {}, 'graph-sparks')
  private statusBeforeRun: string | null = null
  private selected: string | null = null
  private hovered: string | null = null
  /** Pan and zoom. */
  private view = { x: 0, y: 0, k: 1 }
  /** The view is the one Fit chose (nothing panned or zoomed since): keep fitting when the canvas resizes. */
  private fitted = false
  /** How long each function took in the last traced run (the visual profiler), and whether it's shown. */
  private profile: RunProfile | null = null
  private showTimes = true
  private readonly timesToggle: HTMLLabelElement

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
    this.timesToggle = el('label', 'graph-toggle')
    this.timesToggle.title = 'Show how long each function took in the last run'
    const timesBox = el('input')
    timesBox.type = 'checkbox'
    timesBox.checked = this.showTimes
    timesBox.addEventListener('change', () => {
      this.showTimes = timesBox.checked
      this.applyTimes()
      this.renderSide()
    })
    this.timesToggle.append(timesBox, document.createTextNode('Times'))
    this.timesToggle.hidden = true
    this.status = el('span', 'graph-status')
    this.replayBox = el('span', 'graph-replay')
    this.replayBox.hidden = true
    bar.append(
      title, seg, this.focusChip, this.search,
      toggle('Tests', 'Show test files', 'showTests'),
      toggle('Packages', 'Show the packages each module imports (standard library and installed)', 'showExternal'),
      toggle('Web APIs', 'Show the web addresses the code calls (requests, httpx, aiohttp)', 'showHosts'),
      this.timesToggle,
      this.status,
      this.replayBox,
      button('Fit', 'Fit the graph in view (F)', () => this.fit()),
      button('⟳', 'Analyse the project again', () => void this.refresh()),
    )

    // ----- canvas + side -----
    const body = el('div', 'graph-body')
    const canvas = el('div', 'graph-canvas')
    this.canvas = canvas
    this.svgEl = svg('svg', {}, 'graph-svg')
    const defs = svg('defs')
    for (const [id, cls] of [['g-arrow', 'arrow'], ['g-arrow-cyc', 'arrow cyc'], ['g-arrow-out', 'arrow out'], ['g-arrow-in', 'arrow in']]) {
      const m = svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
      m.append(svg('path', { d: 'M0,1 L9,5 L0,9 z' }, cls))
      defs.append(m)
    }
    const heat = svg('linearGradient', { id: 'g-heat', x1: 0, y1: 0, x2: 1, y2: 0 })
    heat.append(svg('stop', { offset: '0%' }, 'heat-stop-a'), svg('stop', { offset: '100%' }, 'heat-stop-b'))
    defs.append(heat)
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
    this.profile = null
    this.timesToggle.hidden = true
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
    this.sparkLayer = svg('g', {}, 'graph-sparks')
    this.world.replaceChildren(edgeLayer, this.sparkLayer, nodeLayer)
    if (this.runGlow) this.nodeEls.get(this.runGlow)?.classList.add('run-at')
    this.applyTimes()
    this.markDebug()
    this.boxLayer = null
    this.redrawBoxes()
  }

  /** Draw the Connect boxes again (they changed, or a test call started or ended). */
  redrawBoxes(): void {
    const hooks = this.hooks.boxes
    if (!hooks || !this.layout) return
    const boxes = hooks.list()
    const ids = new Set(this.data.nodes.map((n) => n.id))
    const placed = placeBoxes(this.layout, boxes, this.opts.mode, ids)
    this.placedBoxes = placed
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const layer = drawBoxLayer(this.layout, placed, boxes, { selected: hooks.selected(), live: hooks.live(), reducedMotion })
    if (this.boxLayer) this.boxLayer.replaceWith(layer)
    else this.world.append(layer)
    this.boxLayer = layer
  }

  /** The times from a traced run (the tracer re-sends them as they add up), or null to clear them. */
  setProfile(p: RunProfile | null): void {
    this.profile = p
    this.timesToggle.hidden = !p
    this.applyTimes()
    this.renderSide()
  }

  /** Each node's time as a badge above it, and the slow ones heated (by their own time, not the calls they make). */
  private applyTimes(): void {
    for (const g of this.nodeEls.values()) {
      g.querySelector('.gtime')?.remove()
      g.classList.remove('hot-1', 'hot-2', 'hot-3')
    }
    if (!this.profile || !this.showTimes || !this.layout) return
    const times = viewTimes(this.profile, this.opts.mode)
    let max = 0
    for (const id of this.nodeEls.keys()) max = Math.max(max, times.get(id)?.selfMs ?? 0)
    for (const [id, g] of this.nodeEls) {
      const t = times.get(id)
      const p = this.layout.nodes.get(id)
      if (!t || !p) continue
      const level = heatLevel(t.selfMs, max)
      if (level) g.classList.add(`hot-${level}`)
      const badge = svg('g', {}, 'gtime')
      const text = svg('text', { x: p.width, y: -5, 'text-anchor': 'end' }, 'gtime-text')
      text.textContent = formatMs(t.totalMs)
      badge.append(text)
      const tip = svg('title')
      tip.textContent = this.opts.mode === 'calls' ? describeTime(t) : `${formatMs(t.selfMs)} running code in this file, ${t.calls} call${t.calls === 1 ? '' : 's'}`
      badge.append(tip)
      g.append(badge)
    }
  }

  /** A function's time in its details: the numbers, and the chain of calls its time comes through. */
  private timeDetails(id: string): HTMLElement[] {
    if (!this.profile || !this.showTimes) return []
    const t = this.profile.fns.get(id)
    if (!t) return []
    const path = timePath(this.profile, id)
    const list = el('div', 'graph-time-path')
    list.append(...path.map((step) => this.item(timeLabel(step), formatMs(this.profile!.fns.get(step)?.totalMs ?? 0), () => this.revealFunction(step), step === id ? 'here' : '')))
    return [
      ...this.section('Time in the last run', [el('div', 'graph-side-intro', describeTime(t))]),
      ...(path.length > 1 ? [el('div', 'graph-side-head', 'Where the time comes from'), list] : [])
    ]
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
    this.placeCard()
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
    const size = boxBounds(layout, this.placedBoxes)
    const k = Math.min(1, (box.width - pad * 2) / size.width, (box.height - pad * 2) / size.height)
    this.view = { k: Math.max(0.05, k), x: (box.width - size.width * k) / 2, y: Math.max(pad, (box.height - size.height * k) / 2) }
    this.applyView()
    this.fitted = true
  }

  /** What is on screen, for the live run planner. */
  runView(): RunView {
    return {
      mode: this.opts.mode,
      nodes: new Set(this.data.nodes.map((n) => n.id)),
      edges: new Set(this.data.edges.map((e) => `${e.from}→${e.to}`))
    }
  }

  /** A traced run's update: the running node glows, sparks fly along the calls. */
  showRun(frame: RunFrame): void {
    if (this.statusBeforeRun === null) {
      this.statusBeforeRun = this.status.textContent ?? ''
      this.status.textContent = '● Running (traced)'
      this.status.classList.add('running')
    }
    if (frame.glow !== this.runGlow) {
      this.fade(this.runGlow, 600)
      if (frame.glow) this.nodeEls.get(frame.glow)?.classList.add('run-at')
      this.runGlow = frame.glow
    }
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) return
    for (const s of frame.sparks) this.sparkAlong(s.from, s.to)
  }

  /** A web request finished: a spark from the code to the API (green ok, red failed), and a ring where it lands. */
  showNet(s: NetSpark): void {
    if (!this.layout) return
    const centre = (r: { x: number; y: number; width: number; height: number } | undefined) => (r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null)
    const a = centre(this.layout.nodes.get(s.from))
    if (!a) return
    const b = s.to === null ? null : 'node' in s.to ? centre(this.layout.nodes.get(s.to.node)) : centre(this.placedBoxes.get(s.to.box))
    const cls = s.ok ? 'net-ok' : 'net-failed'
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const ring = (p: { x: number; y: number }, delay: number) => {
      const c = svg('circle', { cx: p.x, cy: p.y, r: 6 }, `net-ring ${cls}`)
      setTimeout(() => {
        this.world.append(c) // above the nodes and boxes
        setTimeout(() => c.remove(), 700)
      }, delay)
    }
    if (!b || reducedMotion) return ring(b ?? a, 0)
    const spark = svg('circle', { r: 4 }, `net-spark ${cls}`)
    const move = svg('animateMotion', { dur: '0.45s', fill: 'freeze', path: `M${a.x},${a.y} L${b.x},${b.y}`, begin: 'indefinite' })
    spark.append(move)
    this.sparkLayer.append(spark)
    ;(move as SVGAnimationElement).beginElement?.()
    setTimeout(() => spark.remove(), 500)
    ring(b, 420)
  }

  /** A spark along the drawn edge between two nodes (backwards if the edge goes the other way). */
  private sparkAlong(from: string, to: string): void {
    const forward = this.edgeEls.find((e) => e.from === from && e.to === to)
    const edge = forward ?? this.edgeEls.find((e) => e.from === to && e.to === from)
    const d = edge?.el.getAttribute('d')
    if (!d) return
    const spark = svg('circle', { r: 3.5 }, 'run-spark')
    const move = svg('animateMotion', { dur: '0.5s', fill: 'freeze', path: d, begin: 'indefinite', ...(forward ? {} : { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' }) })
    spark.append(move)
    this.sparkLayer.append(spark)
    ;(move as SVGAnimationElement).beginElement?.()
    setTimeout(() => spark.remove(), 550)
  }

  /** Redraw the side panel (something it shows changed, e.g. a recursion tree arrived). */
  refreshSide(): void {
    this.renderSide()
  }

  /**
   * After a traced run: replay it on the graph. `show(i)` draws update i of
   * `count`; `done()` clears the glow when it finishes or is stopped.
   */
  setReplay(count: number, show: (i: number) => void, done: () => void): void {
    this.stopReplay()
    this.replay = count > 1 ? { count, show, done, timer: null, at: 0 } : null
    this.replayBox.hidden = !this.replay
    if (!this.replay) return this.replayBox.replaceChildren()
    const play = el('button', 'graph-button', '▶ Replay')
    play.title = 'Play the last run again on the graph'
    const slider = el('input', 'graph-replay-slider')
    slider.type = 'range'
    slider.min = '0'
    slider.max = String(count - 1)
    slider.value = '0'
    slider.setAttribute('aria-label', 'Position in the run')
    const speed = el('select', 'graph-replay-speed')
    speed.setAttribute('aria-label', 'Replay speed')
    for (const [v, t] of [['0.25', '¼×'], ['0.5', '½×'], ['1', '1×'], ['2', '2×'], ['4', '4×']]) speed.append(new Option(t, v))
    speed.value = '1'
    const r = this.replay
    const step = () => {
      r.show(r.at)
      slider.value = String(r.at)
      if (r.at >= r.count - 1) {
        this.stopReplay()
        return
      }
      r.at++
      r.timer = window.setTimeout(step, 100 / Number(speed.value))
    }
    play.addEventListener('click', () => {
      if (r.timer !== null) return this.stopReplay()
      if (r.at >= r.count - 1) r.at = 0
      play.textContent = '■ Stop'
      step()
    })
    slider.addEventListener('input', () => {
      if (r.timer !== null) {
        window.clearTimeout(r.timer)
        r.timer = null
        play.textContent = '▶ Replay'
      }
      r.at = Number(slider.value)
      r.show(r.at)
    })
    this.replayBox.replaceChildren(play, slider, speed)
  }

  private stopReplay(): void {
    const r = this.replay
    if (!r) return
    if (r.timer !== null) window.clearTimeout(r.timer)
    r.timer = null
    const play = this.replayBox.querySelector('button')
    if (play) play.textContent = '▶ Replay'
    r.done()
  }

  /** The analysed project (null until the first scan). */
  get projectGraph(): ProjectGraph | null {
    return this.graph
  }

  /**
   * Paused in the debugger: the paused function glows, the stack's nodes and
   * the calls between them are marked, calls not seen before get a spark,
   * and `card` (its variables) sits beside the paused node.
   */
  showDebug(p: { at: string | null; stack: string[]; newEdges: [string, string][]; card: HTMLElement | null }): void {
    this.clearDebugMarks()
    this.debugAt = p.at
    this.debugStack = p.stack
    this.markDebug()
    if (this.statusBeforeRun === null) {
      this.statusBeforeRun = this.status.textContent ?? ''
      this.status.classList.add('running')
    }
    this.status.textContent = '⏸ Paused (debugging)'
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reducedMotion) for (const [a, b] of p.newEdges) this.sparkAlong(this.debugView(a), this.debugView(b))
    this.card?.remove()
    this.card = p.card
    if (p.card) {
      this.canvas.append(p.card)
      this.placeCard()
    }
  }

  /** Running again (step / continue): the marks stay until the next pause, the card goes. */
  debugRunning(): void {
    this.card?.remove()
    this.card = null
    if (this.statusBeforeRun !== null) this.status.textContent = '● Running (debugging)'
  }

  /** The debug session ended. */
  endDebug(): void {
    this.clearDebugMarks()
    this.debugAt = null
    this.debugStack = []
    this.card?.remove()
    this.card = null
    if (this.statusBeforeRun !== null) {
      this.status.textContent = this.statusBeforeRun
      this.status.classList.remove('running')
      this.statusBeforeRun = null
    }
  }

  /** A traced id as this view shows it (the module in the Modules view). */
  private debugView(id: string): string {
    if (this.opts.mode === 'calls') return id
    return id.startsWith('module:') ? id.slice(7) : id.slice(0, id.indexOf(':'))
  }

  private markDebug(): void {
    if (!this.debugAt && !this.debugStack.length) return
    const stack = this.debugStack.map((id) => this.debugView(id))
    stack.forEach((id, i) => this.nodeEls.get(id)?.classList.add(i === 0 ? 'debug-at' : 'debug-stack'))
    for (let i = stack.length - 1; i > 0; i--) {
      const from = stack[i]
      const to = stack[i - 1]
      for (const e of this.edgeEls) if ((e.from === from && e.to === to) || (e.from === to && e.to === from)) e.el.classList.add('debug-edge')
    }
  }

  private clearDebugMarks(): void {
    for (const g of this.nodeEls.values()) g.classList.remove('debug-at', 'debug-stack')
    for (const e of this.edgeEls) e.el.classList.remove('debug-edge')
  }

  /** Keep the variables card beside the paused node as the graph pans and zooms. */
  private placeCard(): void {
    if (!this.card) return
    const id = this.debugAt ? this.debugView(this.debugAt) : null
    const p = id ? this.layout?.nodes.get(id) : undefined
    if (!p) {
      this.card.style.display = 'none'
      return
    }
    this.card.style.display = ''
    this.card.style.left = `${Math.round(this.view.x + (p.x + p.width) * this.view.k + 10)}px`
    this.card.style.top = `${Math.round(this.view.y + p.y * this.view.k)}px`
  }

  /** A panel over the canvas (object relationships, a recursion tree); Esc or ✕ closes it. */
  showOverlay(title: string, content: Node): void {
    this.closeOverlay()
    const panel = el('div', 'graph-overlay')
    const head = el('div', 'graph-overlay-head')
    const close = el('button', 'graph-button', '✕')
    close.title = 'Close (Esc)'
    close.addEventListener('click', () => this.closeOverlay())
    head.append(el('span', '', title), close)
    const body = el('div', 'graph-overlay-body')
    body.append(content)
    panel.append(head, body)
    for (const ev of ['pointerdown', 'wheel', 'dblclick']) panel.addEventListener(ev, (e) => e.stopPropagation())
    this.canvas.append(panel)
    this.overlay = panel
    this.el.focus()
  }

  closeOverlay(): void {
    this.overlay?.remove()
    this.overlay = null
  }

  /** The traced run ended: the glow fades and the status line comes back. */
  endRun(): void {
    this.fade(this.runGlow, 1000)
    this.runGlow = null
    if (this.statusBeforeRun !== null) {
      this.status.textContent = this.statusBeforeRun
      this.status.classList.remove('running')
      this.statusBeforeRun = null
    }
  }

  private fade(id: string | null, ms: number): void {
    const el = id ? this.nodeEls.get(id) : undefined
    if (!el) return
    el.classList.remove('run-at')
    el.classList.add('run-was')
    setTimeout(() => {
      if (!el.classList.contains('run-at')) el.classList.remove('run-was')
    }, ms)
  }

  /** Pan so a box is fully in view (after Box settings opened and the canvas got narrower). */
  revealBox(id: string): void {
    const p = this.placedBoxes.get(id)
    const box = this.svgEl.getBoundingClientRect()
    if (!p || !box.width) return
    this.view = panToShow(this.view, p, box)
    this.applyView()
    this.fitted = false
  }

  private wireCanvas(canvas: HTMLDivElement): void {
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null
    const nodeAt = (target: EventTarget | null) => (target as Element | null)?.closest?.('.gnode') as SVGGElement | null
    // The canvas changes size when a panel opens beside it (Box settings) or the window resizes:
    // refit a fitted view, else keep the selected box in sight. (Measured after the resize, not guessed.)
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        const sel = this.hooks.boxes?.selected()
        if (this.fitted) this.fit()
        else if (sel) this.revealBox(sel)
      }).observe(canvas)
    }
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
          this.fitted = false
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
      // A click (not a drag): select the box or node under the pointer, or nothing.
      const target = document.elementFromPoint(e.clientX, e.clientY)
      const box = (target as Element | null)?.closest?.('.gbox')?.getAttribute('data-box')
      if (box && this.hooks.boxes) {
        this.hooks.boxes.select(box)
        requestAnimationFrame(() => this.revealBox(box))
        return
      }
      this.hooks.boxes?.clear()
      this.select(nodeAt(target)?.dataset.id ?? null)
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.hovered) {
        this.hovered = null
        this.applyHighlight()
      }
    })
    // A box dragged from the Toolbox: onto a module (its code goes in that file) or empty canvas.
    canvas.addEventListener('dragover', (e) => {
      if (!this.hooks.boxes || !e.dataTransfer?.types.includes(BOX_DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    })
    canvas.addEventListener('drop', (e) => {
      if (!this.hooks.boxes || !e.dataTransfer?.types.includes(BOX_DRAG_TYPE)) return
      e.preventDefault()
      const id = nodeAt(document.elementFromPoint(e.clientX, e.clientY))?.dataset.id
      const node = id ? this.data.nodes.find((n) => n.id === id) : undefined
      this.hooks.boxes.drop(node?.module ?? null)
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
      this.fitted = false
    }, { passive: false })
  }

  private onKey(e: KeyboardEvent): void {
    const typing = e.target === this.search
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      if (this.overlay) this.closeOverlay()
      else if (typing && this.search.value) {
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

  /** A function from the profile: shown in the Calls view (switching to it if needed). */
  private revealFunction(id: string): void {
    if (this.opts.mode !== 'calls' || !this.layout?.nodes.has(id)) this.setOptions({ mode: 'calls', focus: null, query: '' })
    this.reveal(id)
  }

  /** Select a node and bring it into view. */
  reveal(id: string): void {
    const p = this.layout?.nodes.get(id)
    if (!p) return
    const box = this.svgEl.getBoundingClientRect()
    this.view.k = Math.max(this.view.k, 0.8)
    this.view.x = box.width / 2 - (p.x + p.width / 2) * this.view.k
    this.view.y = box.height / 2 - (p.y + p.height / 2) * this.view.k
    this.applyView()
    this.fitted = false
    this.select(id)
  }

  private open(id: string): void {
    const n = this.data.nodes.find((x) => x.id === id)
    const m = n?.module ? this.graph?.modules.find((x) => x.id === n.module) : undefined
    if (n && m) this.hooks.openModule(m.path, n.line ?? 0)
  }

  /** Open the code for a traced id (`module:qual` or `module:<module>`); false if the graph doesn't know it yet. */
  openTraced(id: string): boolean {
    const g = this.graph
    if (!g) return false
    const isModule = id.startsWith('module:')
    const module = isModule ? id.slice(7) : id.slice(0, id.indexOf(':'))
    const m = g.modules.find((x) => x.id === module)
    if (!m) return false
    const s = isModule ? undefined : m.symbols.find((x) => x.id === id)
    this.hooks.openModule(m.path, s ? s.line - 1 : 0)
    return true
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
      ...(this.profile && this.showTimes
        ? this.section('Slowest in the last run', slowest(this.profile, 5).filter((s) => s.selfMs >= 0.05).map((s) =>
          this.item(timeLabel(s.id), `${formatMs(s.selfMs)} in its own code · ${s.calls} call${s.calls === 1 ? '' : 's'}`, () => this.revealFunction(s.id), 'hot')))
        : []),
      ...this.section('Import cycles', g.cycles.map((c) => this.item(c.join(' ⇄ '), '', () => this.revealModule(c[0]), 'warn')), 'None: no modules import each other in a loop.'),
      ...this.section('Possibly unused', g.unused.map((s) => this.item(`${s.module}.${s.qual}`, `${s.kind}, line ${s.line}`, () => this.openAt(s.module, s.line - 1))),
        'Every function and class is used somewhere.'),
      ...this.section('Code that never runs', g.unreachable.map((u) => this.item(short(u.module, u.func), describeUnreachable(u), () => this.openAt(u.module, u.line - 1))),
        'None found.'),
      ...this.section('Web routes', g.routes.map((r) => this.item(`${r.methods.join(' ')} ${r.path}`, short(r.module, r.func), () => this.openAt(r.module, r.line - 1)))),
      ...this.section('Web APIs called', g.http.map((h) => this.item(`${h.method} ${h.url ?? '(address built at run time)'}`, `${h.library} · ${short(h.module, h.func)}`, () => this.openAt(h.module, h.line - 1)))),
      ...this.section('Environment variables', g.env.map((e) => this.item(e.name, e.uses.map((u) => short(u.module, u.func)).join(', ') + (e.uses.every((u) => u.default) ? ' · has a default' : ''),
        () => this.openAt(e.uses[0].module, e.uses[0].line - 1)))),
      ...this.section('Files that could not be read', g.errors.map((x) => this.item(x.path, x.error, () => this.openAt(x.module, 0), 'warn')))
    ]
  }

  /** Show a module: the Modules view, selected and centred. */
  revealModule(module: string): void {
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
    if (n.module && this.hooks.showDataFlow && (n.kind === 'function' || n.kind === 'method')) action('Data flow', () => this.hooks.showDataFlow!(n.id))
    const out: HTMLElement[] = [head, sub, actions]
    const nb = neighbourhood(this.data.edges, n.id)
    const label = (id: string) => this.data.nodes.find((x) => x.id === id)?.label ?? id
    const links = (ids: Set<string>) => [...ids].sort().map((id) => this.item(label(id), '', () => this.reveal(id)))

    if (n.kind === 'module') {
      const m = g.modules.find((x) => x.id === n.id)!
      action('Show its calls', () => this.setOptions({ mode: 'calls', focus: m.id, query: '' }))
      sub.textContent = `${m.path} · ${n.detail}`
      if (m.error) out.push(el('div', 'graph-side-warn', m.error))
      if (m.generated) {
        out.push(el('div', m.generated.edited ? 'graph-side-warn' : 'graph-side-intro', m.generated.edited
          ? 'Generated by Forge from an OpenAPI description, and edited by hand since. Generating it again asks before replacing your edits.'
          : 'Generated by Forge from an OpenAPI description (Add API from OpenAPI). Edit it freely: Forge will notice.'))
      }
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
        ...this.section('Environment variables', m.env.map((e) => this.item(e.name, `line ${e.line}`, () => this.openAt(m.id, e.line - 1)))),
        ...this.section('Code that never runs', g.unreachable.filter((u) => u.module === m.id).map((u) =>
          this.item(u.func ?? 'top level', describeUnreachable(u), () => this.openAt(m.id, u.line - 1), 'warn')))
      )
      if (this.profile && this.showTimes) {
        const mine = slowest({ fns: new Map([...this.profile.fns].filter(([id]) => id.startsWith(`${m.id}:`) || id === `module:${m.id}`)), edges: new Map() }, 5)
        out.push(...this.section('Slowest in the last run', mine.map((s) => this.item(timeLabel(s.id), `${formatMs(s.selfMs)} in its own code`, () => this.revealFunction(s.id)))))
      }
      const run = this.hooks.runDetails?.(m.id)
      if (run) out.push(...this.section('Last run', [run]))
    } else if (n.kind === 'external' || n.kind === 'host') {
      out.push(...this.section(n.kind === 'host' ? 'Called from' : 'Imported by', links(nb.in)))
      if (n.kind === 'host') {
        const host = n.id.slice(5)
        out.push(...this.section('Requests', g.http.filter((h) => h.host === host).map((h) =>
          this.item(`${h.method} ${h.url}`, `${h.module}${h.func ? '.' + h.func : ''}`, () => this.openAt(h.module, h.line - 1)))))
      }
    } else {
      if (n.unused) out.push(el('div', 'graph-side-warn', 'Nothing in the project seems to use this (it may still be used dynamically, or from outside).'))
      const history = this.hooks.debugHistory?.(n.id)
      if (history) out.push(...this.section('While debugging', [history]))
      out.push(...this.timeDetails(n.id))
      const run = this.hooks.runDetails?.(n.id)
      if (run) out.push(...this.section('Last run', [run]))
      const qual = n.id.slice(n.id.indexOf(':') + 1)
      for (const u of g.unreachable.filter((x) => x.module === n.module && x.func === qual)) {
        const warn = el('button', 'graph-side-warn graph-side-link', `Code that never runs: ${describeUnreachable(u)}`)
        warn.addEventListener('click', () => this.openAt(u.module, u.line - 1))
        out.push(warn)
      }
      out.push(...this.section('Calls', links(nb.out)), ...this.section('Called by', links(nb.in)))
    }
    return out
  }
}
