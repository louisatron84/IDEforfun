/**
 * The Network panel: every web request and connection a traced run makes
 * (see src/shared/network.ts). A timeline, a list you can filter and group,
 * the details of the one you click, and a comparison with the previous run.
 */
import {
  compareRuns, filterRecords, funcLabel, groupRecords, isSlow, stateOf, timelineLanes,
  type NetFilter, type NetLog, type NetRecord
} from '../shared/network'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const SVG = 'http://www.w3.org/2000/svg'

export function statusText(r: NetRecord): string {
  if (r.error) return r.error.split(':')[0]
  if (r.status !== null) return String(r.status)
  if (r.kind === 'socket') return r.ms === null ? '…' : 'connected'
  return '…'
}

export function msText(ms: number | null): string {
  if (ms === null) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`
}

/** JSON bodies are shown indented; anything else as it came. */
export function prettyBody(body: string): string {
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2)
    } catch {
      // cut short (bodies are capped) or not JSON after all
    }
  }
  return body
}

export class NetworkView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly filterInput: HTMLInputElement
  private readonly onlySelect: HTMLSelectElement
  private readonly groupSelect: HTMLSelectElement
  private readonly compareButton: HTMLButtonElement
  private readonly timeline: SVGSVGElement
  private readonly list: HTMLDivElement
  private readonly details: HTMLDivElement
  private readonly summary: HTMLSpanElement
  private selected: number | null = null
  private comparing = false
  private queued = false
  private running = false
  private runStartedAt = 0

  constructor(
    private readonly log: NetLog,
    private readonly opts: { openFunc(func: string): void; clear(): void }
  ) {
    this.body = el('div', 'network-view')
    this.actions = el('div', 'panel-buttons')
    const clear = el('button', '', 'Clear')
    clear.title = 'Forget the requests of this run and the last one'
    clear.addEventListener('click', () => {
      this.selected = null
      opts.clear()
    })
    this.actions.append(clear)

    const bar = el('div', 'network-bar')
    this.filterInput = el('input', 'network-filter')
    this.filterInput.type = 'search'
    this.filterInput.placeholder = 'Filter: address, method, status, function'
    this.filterInput.setAttribute('aria-label', 'Filter requests')
    this.onlySelect = el('select')
    this.onlySelect.setAttribute('aria-label', 'Show')
    for (const [v, t] of [['all', 'All'], ['failed', 'Failed'], ['slow', 'Slow (1 s+)']]) this.onlySelect.append(new Option(t, v))
    this.groupSelect = el('select')
    this.groupSelect.setAttribute('aria-label', 'Group by')
    for (const [v, t] of [['none', 'No grouping'], ['host', 'By host'], ['func', 'By function']]) this.groupSelect.append(new Option(t, v))
    this.compareButton = el('button', 'network-compare', 'Compare with last run')
    this.compareButton.setAttribute('aria-pressed', 'false')
    this.compareButton.addEventListener('click', () => {
      this.comparing = !this.comparing
      this.compareButton.setAttribute('aria-pressed', String(this.comparing))
      this.render()
    })
    this.summary = el('span', 'network-summary')
    bar.append(this.filterInput, this.onlySelect, this.groupSelect, this.compareButton, this.summary)
    for (const c of [this.filterInput, this.onlySelect, this.groupSelect]) c.addEventListener('input', () => this.render())

    this.timeline = document.createElementNS(SVG, 'svg')
    this.timeline.classList.add('network-timeline')
    this.timeline.setAttribute('role', 'img')
    this.timeline.setAttribute('aria-label', 'When each request happened')
    const main = el('div', 'network-main')
    this.list = el('div', 'network-list')
    this.list.setAttribute('role', 'list')
    this.details = el('div', 'network-details')
    main.append(this.list, this.details)
    this.body.append(bar, this.timeline, main)
    this.render()
  }

  /** A traced run started or ended (pending requests stop growing on the timeline once it ends). */
  setRunning(running: boolean): void {
    this.running = running
    if (running) {
      this.runStartedAt = performance.now()
      this.selected = null
    }
    this.update()
  }

  /** Something changed: redraw on the next frame (requests can arrive many at a time). */
  update(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.render()
    })
  }

  private get filter(): NetFilter {
    return { text: this.filterInput.value, only: this.onlySelect.value as NetFilter['only'] }
  }

  private render(): void {
    const all = this.log.current
    const shown = filterRecords(all, this.filter)
    const failed = all.filter((r) => stateOf(r) === 'failed').length
    const slow = all.filter(isSlow).length
    this.summary.textContent = all.length
      ? `${all.length} request${all.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}${slow ? ` · ${slow} slow` : ''}`
      : ''
    this.compareButton.disabled = !this.log.previous.length
    if (this.comparing && this.log.previous.length) {
      this.timeline.replaceChildren()
      this.timeline.style.display = 'none'
      this.renderCompare()
      this.details.replaceChildren()
      return
    }
    this.timeline.style.display = all.length ? '' : 'none'
    this.renderTimeline(shown)
    this.renderList(shown, all.length)
    this.renderDetails()
  }

  private renderTimeline(recs: NetRecord[]): void {
    const now = this.running ? performance.now() - this.runStartedAt : Math.max(0, ...recs.map((r) => r.start + (r.ms ?? 0)))
    const lanes = timelineLanes(recs, now)
    const span = Math.max(1, ...lanes.map((l) => l.end))
    const laneCount = Math.min(12, Math.max(1, ...lanes.map((l) => l.lane + 1)))
    const h = 6
    this.timeline.setAttribute('viewBox', `0 0 1000 ${laneCount * (h + 2) + 14}`)
    this.timeline.setAttribute('preserveAspectRatio', 'none')
    const parts: SVGElement[] = []
    const byId = new Map(recs.map((r) => [r.id, r]))
    for (const l of lanes) {
      if (l.lane >= laneCount) continue
      const r = byId.get(l.id)!
      const bar = document.createElementNS(SVG, 'rect')
      bar.setAttribute('x', String((l.start / span) * 1000))
      bar.setAttribute('y', String(l.lane * (h + 2)))
      bar.setAttribute('width', String(Math.max(3, ((l.end - l.start) / span) * 1000)))
      bar.setAttribute('height', String(h))
      bar.setAttribute('class', `net-bar ${stateOf(r)}${isSlow(r) ? ' slow' : ''}${r.id === this.selected ? ' selected' : ''}`)
      const title = document.createElementNS(SVG, 'title')
      title.textContent = `${r.method} ${r.url} · ${statusText(r)} · ${msText(r.ms)} (at ${msText(r.start)})`
      bar.append(title)
      bar.addEventListener('click', () => this.select(r.id))
      parts.push(bar)
    }
    const axis = document.createElementNS(SVG, 'text')
    axis.setAttribute('x', '1000')
    axis.setAttribute('y', String(laneCount * (h + 2) + 11))
    axis.setAttribute('text-anchor', 'end')
    axis.setAttribute('class', 'net-axis')
    axis.textContent = msText(span)
    parts.push(axis)
    this.timeline.replaceChildren(...parts)
  }

  private renderList(recs: NetRecord[], total: number): void {
    if (!total) {
      this.list.replaceChildren(el('div', 'network-empty',
        'Press ▶ Run to see the web requests your program makes. They are recorded while this panel or the Graph is on screen.'))
      return
    }
    if (!recs.length) {
      this.list.replaceChildren(el('div', 'network-empty', 'Nothing matches the filter.'))
      return
    }
    const out: HTMLElement[] = []
    for (const g of groupRecords(recs, this.groupSelect.value as 'none' | 'host' | 'func')) {
      if (g.label) {
        const head = el('div', 'network-group')
        head.append(el('span', '', g.label), el('span', 'network-group-info',
          `${g.records.length}${g.failed ? ` · ${g.failed} failed` : ''} · slowest ${msText(g.slowest)}`))
        out.push(head)
      }
      for (const r of g.records) out.push(this.row(r))
    }
    this.list.replaceChildren(...out)
  }

  private row(r: NetRecord): HTMLElement {
    const state = stateOf(r)
    const row = el('button', `network-row ${state}${isSlow(r) ? ' slow' : ''}${r.id === this.selected ? ' selected' : ''}`)
    row.setAttribute('role', 'listitem')
    row.append(
      el('span', 'net-method', r.method),
      el('span', 'net-url', r.url),
      el('span', `net-status ${state}`, statusText(r)),
      el('span', 'net-ms', msText(r.ms)),
      el('span', 'net-func', r.func ? funcLabel(r.func) : '')
    )
    row.title = `${r.method} ${r.url}`
    row.addEventListener('click', () => this.select(r.id))
    row.addEventListener('dblclick', () => r.func && this.opts.openFunc(r.func))
    return row
  }

  private select(id: number): void {
    this.selected = this.selected === id ? null : id
    this.render()
  }

  private renderDetails(): void {
    const r = this.selected === null ? undefined : this.log.get(this.selected)
    this.details.hidden = !r
    if (!r) return this.details.replaceChildren()
    const head = el('div', 'network-detail-head')
    head.append(el('strong', '', `${r.method} `), el('span', 'net-url', r.url))
    const facts = el('dl', 'network-facts')
    const fact = (k: string, v: string | HTMLElement) => {
      facts.append(el('dt', '', k))
      const dd = el('dd')
      dd.append(v)
      facts.append(dd)
    }
    fact('Status', r.error ?? (r.status !== null ? String(r.status) : r.ms === null ? 'still going' : 'connected'))
    fact('Time', r.ms === null ? 'still going' : msText(r.ms))
    fact('Started', `${msText(r.start) || '0 ms'} into the run`)
    if (r.size !== null) fact('Size', r.size >= 1024 ? `${(r.size / 1024).toFixed(1)} KB` : `${r.size} bytes`)
    fact('Library', r.lib)
    if (r.func) {
      const link = el('button', 'network-link', funcLabel(r.func))
      link.title = 'Open the code that made this request'
      link.addEventListener('click', () => this.opts.openFunc(r.func!))
      fact('Made by', link)
    } else fact('Made by', 'code outside your project')
    const section = (title: string, content: HTMLElement | null) => {
      if (!content) return []
      return [el('div', 'network-section', title), content]
    }
    const headers = (list: [string, string][]) => {
      if (!list.length) return null
      const t = el('dl', 'network-headers')
      for (const [k, v] of list) t.append(el('dt', '', k), el('dd', '', v))
      return t
    }
    const bodyPre = (b: string | null) => (b ? el('pre', 'network-body', prettyBody(b)) : null)
    this.details.replaceChildren(
      head, facts,
      ...section('Request headers', headers(r.reqHeaders)),
      ...section('Request body', bodyPre(r.reqBody)),
      ...section('Response headers', headers(r.respHeaders)),
      ...section('Response body (first 4 KB)', bodyPre(r.respBody)),
      el('p', 'network-note', 'Passwords, keys and tokens are hidden before they leave your program.')
    )
  }

  private renderCompare(): void {
    const rows = compareRuns(this.log.previous, this.log.current)
    const table = el('table', 'network-compare-table')
    const head = el('tr')
    for (const t of ['Endpoint', 'Last run', 'This run', 'Change']) head.append(el('th', '', t))
    table.append(head)
    const side = (s: { count: number; avgMs: number; failed: number }) =>
      s.count ? `${s.count}× · ${msText(s.avgMs)}${s.failed ? ` · ${s.failed} failed` : ''}` : '—'
    const words: Record<string, string> = {
      new: 'new', gone: 'gone', failing: 'failing more', fixed: 'failing less', slower: 'slower', faster: 'faster', more: 'more calls', fewer: 'fewer calls', same: ''
    }
    for (const r of rows) {
      const tr = el('tr', `change-${r.change}`)
      tr.append(el('td', 'net-url', r.endpoint), el('td', '', side(r.before)), el('td', '', side(r.after)), el('td', 'net-change', words[r.change]))
      table.append(tr)
    }
    this.list.replaceChildren(rows.length ? table : el('div', 'network-empty', 'No requests in either run.'))
  }
}
