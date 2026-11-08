/**
 * The Memory panel: a run with memory tracking (the run tracer with
 * FORGE_TRACE_MEMORY) shows how much memory the program uses over time,
 * which of the project's lines allocate it, how many objects of each of the
 * project's classes are alive (and whether that keeps growing), and what
 * keeps objects alive when the program ends.
 */
import { formatBytes, type MemoryLog } from '../../shared/memory'

export interface MemoryHooks {
  /** Run the program with memory tracking. */
  run(): void
  /** The function a project line is in ("app.load"), or null. */
  describe(path: string, line: number): string | null
  /** Open a project file at a 0-based line. */
  openAt(path: string, line: number): void
}

const SVG = 'http://www.w3.org/2000/svg'
const CHART_W = 600
const CHART_H = 110

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (cls) e.setAttribute('class', cls)
  return e
}

export class MemoryView {
  readonly el: HTMLDivElement
  private readonly status: HTMLSpanElement
  private readonly body: HTMLDivElement

  constructor(private readonly log: MemoryLog, private readonly hooks: MemoryHooks) {
    this.el = el('div', 'mem-view')
    const bar = el('div', 'graph-toolbar')
    const run = el('button', 'graph-button', '▶ Run with memory tracking')
    run.dataset.action = 'run-memory'
    run.title = 'Run the program and track its memory (it runs slower while tracking)'
    run.addEventListener('click', () => this.hooks.run())
    this.status = el('span', 'graph-status')
    bar.append(el('span', 'graph-title', 'Memory'), run, this.status)
    this.body = el('div', 'mem-body')
    this.el.append(bar, this.body)
    this.update()
  }

  /** Draw what the log holds now. */
  update(): void {
    const log = this.log
    if (log.runId < 0 || (!log.samples.length && !log.running)) {
      this.status.textContent = ''
      this.body.replaceChildren(el('p', 'graph-side-intro',
        'Run your program with memory tracking to see how much memory it uses over time, which of your lines allocate it, ' +
        'how many objects of your classes stay alive, and what keeps them alive. The program runs 2 to 4 times slower while tracking.'))
      return
    }
    const now = log.samples.at(-1)?.[1] ?? 0
    this.status.textContent = `${log.running ? `Running · ${formatBytes(now)} in use · ` : ''}Peak ${formatBytes(log.peak)}`
    const parts: HTMLElement[] = [this.chart()]

    const sites = log.sites.slice(0, 12)
    const biggest = sites[0]?.bytes ?? 1
    parts.push(...this.section('Where memory is allocated', sites.map((s) => {
      const row = el('div', 'graph-item mem-site')
      row.title = 'Memory still in use that was allocated by this line (or by code it called). Click to open it.'
      const fn = this.hooks.describe(s.path, s.line)
      const bar = el('span', 'mem-bar')
      bar.style.width = `${Math.max(2, Math.round((s.bytes / biggest) * 100))}%`
      row.append(el('span', 'graph-item-text', fn ?? s.path), el('span', 'graph-item-detail', `${s.path}:${s.line} · ${formatBytes(s.bytes)} · ${s.count} block${s.count === 1 ? '' : 's'}`), bar)
      row.addEventListener('click', () => this.hooks.openAt(s.path, s.line - 1))
      return row
    }), log.running ? 'Collecting…' : 'Nothing allocated by your code is still in use.'))

    const types = [...log.types.keys()].sort((a, b) => log.count(b) - log.count(a)).slice(0, 15)
    parts.push(...this.section('Objects of your classes', types.map((t) => {
      const row = el('div', 'graph-item mem-type')
      const grows = log.growing(t)
      row.append(el('span', 'graph-item-text', t), el('span', 'graph-item-detail', `${log.count(t)} alive${grows ? ' · growing' : ''}`))
      if (grows) {
        row.classList.add('warn')
        row.title = 'The number alive kept going up during the run: something may be holding on to them.'
      }
      return row
    }), log.running ? 'Collecting…' : 'No objects of your own classes are alive.'))

    if (!log.running) {
      parts.push(...this.section('Still alive when the program ended', log.kept.map((k) => {
        const row = el('div', 'graph-item mem-kept')
        const how = k.path.length ? `kept by ${k.path.join(' → ')}` : 'kept by something outside your code'
        row.append(el('span', 'graph-item-text', `${k.count} ${k.type}, ${how}`))
        row.title = 'Objects stay alive while something refers to them. Only a problem if you expected them to be gone.'
        return row
      })))
    }
    this.body.replaceChildren(...parts)
  }

  private section(title: string, items: HTMLElement[], empty?: string): HTMLElement[] {
    if (!items.length && !empty) return []
    return [el('div', 'graph-side-head', title), ...(items.length ? items : [el('div', 'graph-side-empty', empty)])]
  }

  /** Memory in use over the run, with the peak marked. */
  private chart(): HTMLElement {
    const wrap = el('div', 'mem-chart')
    const s = this.log.samples
    const chart = svg('svg', { viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: 'none', role: 'img' })
    chart.setAttribute('aria-label', `Memory in use over the run, peak ${formatBytes(this.log.peak)}`)
    const maxT = Math.max(s.at(-1)?.[0] ?? 0, 0.001)
    const maxB = Math.max(this.log.peak, 1)
    const x = (t: number) => (t / maxT) * (CHART_W - 4) + 2
    const y = (b: number) => CHART_H - 4 - (b / maxB) * (CHART_H - 12)
    chart.append(svg('line', { x1: 0, x2: CHART_W, y1: y(maxB), y2: y(maxB) }, 'mem-peak'))
    if (s.length) chart.append(svg('polyline', { points: s.map(([t, b]) => `${x(t).toFixed(1)},${y(b).toFixed(1)}`).join(' ') }, 'mem-line'))
    wrap.append(chart, el('div', 'mem-chart-caption', `${formatBytes(s.at(-1)?.[1] ?? 0)} now · peak ${formatBytes(this.log.peak)} · ${(s.at(-1)?.[0] ?? 0).toFixed(1)} s`))
    return wrap
  }
}
