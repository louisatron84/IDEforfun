/**
 * The Database explorer: the project's tables as a schema diagram (columns,
 * keys, a line for each foreign key), built from the code by the project
 * analysis (see src/shared/database.ts). Drag to pan, wheel to zoom, click a
 * table for its details, double-click to open its code. With nothing
 * selected, the side lists the connections the code makes and every table.
 */
import type { DbSchema, DbTable } from '../../shared/database'
import { layoutGraph, type Layout } from '../graph/layout'

export interface DatabaseHooks {
  /** Analyse the project (again) and build the schema. */
  scan(): Promise<{ schema?: DbSchema; error?: string }>
  /** Open a project file (relative path) at a 0-based line. */
  openAt(path: string, line: number): void
  /** Open a function (`module:qual`). */
  openFunction(id: string): void
}

const SVG = 'http://www.w3.org/2000/svg'
const HEAD_H = 28
const ROW_H = 18
const MAX_ROWS = 24
const CHAR_W = 7

const FRAMEWORK: Record<string, string> = { sqlalchemy: 'SQLAlchemy', sqlmodel: 'SQLModel', django: 'Django', peewee: 'Peewee' }
const KIND: Record<string, string> = { sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL', mongo: 'MongoDB', redis: 'Redis', sql: 'SQL' }

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

/** `app:load` → "app.load". */
const funcLabel = (id: string) => id.replace(':', '.')

export class DatabaseView {
  readonly el: HTMLDivElement
  private readonly svgEl: SVGSVGElement
  private readonly world: SVGGElement
  private readonly side: HTMLDivElement
  private readonly note: HTMLDivElement
  private readonly status: HTMLSpanElement
  private schema: DbSchema | null = null
  private layout: Layout | null = null
  private selected: string | null = null
  private loading = false
  private view = { x: 20, y: 20, k: 1 }
  private readonly tableEls = new Map<string, SVGGElement>()

  constructor(private readonly hooks: DatabaseHooks) {
    this.el = el('div', 'db-view')
    this.el.setAttribute('role', 'region')
    this.el.setAttribute('aria-label', 'Database')
    const bar = el('div', 'graph-toolbar')
    const button = (label: string, tip: string, fn: () => void) => {
      const b = el('button', 'graph-button', label)
      b.title = tip
      b.addEventListener('click', fn)
      return b
    }
    this.status = el('span', 'graph-status')
    bar.append(el('span', 'graph-title', 'Database'), this.status,
      button('Fit', 'Fit the tables in view', () => this.fit()),
      button('⟳', 'Analyse the project again', () => void this.refresh()))
    const body = el('div', 'graph-body')
    const canvas = el('div', 'graph-canvas')
    this.svgEl = svg('svg', {}, 'graph-svg')
    const defs = svg('defs')
    const m = svg('marker', { id: 'db-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
    m.append(svg('path', { d: 'M0,1 L9,5 L0,9 z' }, 'arrow'))
    defs.append(m)
    this.world = svg('g')
    this.svgEl.append(defs, this.world)
    this.note = el('div', 'graph-note db-note')
    this.note.hidden = true
    canvas.append(this.svgEl, this.note)
    this.side = el('div', 'graph-side db-side')
    body.append(canvas, this.side)
    this.el.append(bar, body)
    this.wireCanvas(canvas)
  }

  /** Forget everything (another folder was opened). */
  reset(): void {
    this.schema = null
    this.selected = null
    this.world.replaceChildren()
    this.side.replaceChildren()
  }

  async refresh(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.status.textContent = 'Analysing…'
    try {
      const res = await this.hooks.scan()
      if (!res.schema) {
        this.showNote(`Couldn't analyse the project: ${res.error ?? 'no result'}`)
        this.status.textContent = ''
        return
      }
      const first = this.schema === null
      this.schema = res.schema
      if (this.selected && !res.schema.tables.some((t) => t.id === this.selected)) this.selected = null
      this.render(first)
    } finally {
      this.loading = false
    }
  }

  select(id: string | null): void {
    this.selected = id
    for (const [tid, g] of this.tableEls) g.classList.toggle('selected', tid === id)
    this.renderSide()
  }

  private showNote(text: string | null): void {
    this.note.hidden = !text
    this.note.textContent = text ?? ''
  }

  private render(fit: boolean): void {
    const s = this.schema!
    const t = s.tables.length
    this.status.textContent = t ? `${t} table${t === 1 ? '' : 's'}, ${s.relations.length} link${s.relations.length === 1 ? '' : 's'}` : ''
    this.showNote(t ? null : s.connections.length
      ? 'The code connects to a database, but no tables were found in it. Forge looks for SQLAlchemy, SQLModel, Django and Peewee models, CREATE TABLE statements, and SQLite files in the project.'
      : 'No database code found. Forge looks for SQLAlchemy, SQLModel, Django and Peewee models, CREATE TABLE statements, and connections such as sqlite3.connect() or create_engine().')
    const sizes = s.tables.map((tb) => ({
      id: tb.id,
      width: Math.ceil(Math.max(170, (tb.name.length + 8) * CHAR_W, ...tb.columns.map((c) => (c.name.length + this.typeText(c).length + 6) * CHAR_W))),
      height: HEAD_H + Math.min(tb.columns.length, MAX_ROWS + 1) * ROW_H + 6
    }))
    this.layout = layoutGraph(sizes, s.relations.filter((r) => r.from !== r.to).map((r) => ({ from: r.from, to: r.to })), { gapX: 90, gapY: 24 })
    this.draw()
    if (fit) this.fit()
    this.renderSide()
  }

  private typeText(c: { type: string; fk?: string }): string {
    return c.fk ? `→ ${c.fk}` : c.type
  }

  private draw(): void {
    const s = this.schema!
    const layout = this.layout!
    const edges = svg('g', {}, 'db-edges')
    const nodes = svg('g', {}, 'db-tables')
    this.tableEls.clear()
    for (const r of s.relations) {
      const a = layout.nodes.get(r.from)
      const b = layout.nodes.get(r.to)
      if (!a || !b) continue
      // From the key's row (or the table's middle) to the table it refers to.
      const table = s.tables.find((t) => t.id === r.from)!
      const row = r.column ? table.columns.findIndex((c) => c.name === r.column) : -1
      const y1 = row >= 0 && row <= MAX_ROWS ? a.y + HEAD_H + row * ROW_H + ROW_H / 2 + 3 : a.y + a.height / 2
      const toRight = b.x >= a.x + a.width
      const x1 = toRight ? a.x + a.width : a.x
      const x2 = toRight ? b.x : b.x + b.width
      const y2 = b.y + HEAD_H / 2
      const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (toRight ? 1 : -1)
      const path = svg('path', { d: r.from === r.to
        ? `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${y2} ${x1},${y2}`
        : `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`, 'marker-end': 'url(#db-arrow)' }, `dbedge k-${r.kind}`)
      const tip = svg('title')
      tip.textContent = r.kind === 'fk' ? `${table.name}.${r.column} refers to ${r.to}` : r.kind === 'many' ? `${table.name} ↔ ${r.to} (many-to-many)` : `${table.name} → ${r.to} (relationship)`
      path.append(tip)
      edges.append(path)
    }
    for (const t of s.tables) {
      const p = layout.nodes.get(t.id)
      if (!p) continue
      const g = svg('g', { transform: `translate(${p.x},${p.y})` }, `dbtable${t.id === this.selected ? ' selected' : ''}${t.sources.includes('model') || t.sources.includes('sql') ? '' : ' file-only'}`)
      g.dataset.id = t.id
      g.append(svg('rect', { width: p.width, height: p.height, rx: 6 }, 'dbtable-frame'))
      g.append(svg('rect', { width: p.width, height: HEAD_H, rx: 6 }, 'dbtable-head'))
      const title = svg('text', { x: 10, y: 18 }, 'dbtable-name')
      title.textContent = t.name
      const tag = svg('text', { x: p.width - 8, y: 18, 'text-anchor': 'end' }, 'dbtable-tag')
      tag.textContent = t.model ?? (t.sources.includes('sql') ? 'SQL' : 'file')
      g.append(title, tag)
      t.columns.slice(0, MAX_ROWS).forEach((c, i) => {
        const row = svg('g', { transform: `translate(0,${HEAD_H + i * ROW_H + 3})` }, `dbrow${c.pk ? ' pk' : ''}${c.fk ? ' fk' : ''}`)
        const name = svg('text', { x: 10, y: 13 }, 'dbcol-name')
        name.textContent = c.name
        const type = svg('text', { x: p.width - 8, y: 13, 'text-anchor': 'end' }, 'dbcol-type')
        type.textContent = this.typeText(c)
        row.append(svg('rect', { x: 1, width: p.width - 2, height: ROW_H }, 'dbrow-bg'), name, type)
        if (c.pk) {
          const key = svg('text', { x: 10 + c.name.length * CHAR_W + 6, y: 13 }, 'dbcol-key')
          key.textContent = 'key'
          row.append(key)
        }
        g.append(row)
      })
      if (t.columns.length > MAX_ROWS) {
        const more = svg('text', { x: 10, y: HEAD_H + MAX_ROWS * ROW_H + 16 }, 'dbcol-type')
        more.textContent = `+ ${t.columns.length - MAX_ROWS} more`
        g.append(more)
      }
      nodes.append(g)
      this.tableEls.set(t.id, g)
    }
    this.world.replaceChildren(edges, nodes)
    this.applyView()
  }

  fit(): void {
    const layout = this.layout
    const box = this.svgEl.getBoundingClientRect()
    if (!layout || !layout.width || !box.width) {
      this.view = { x: 20, y: 20, k: 1 }
      return this.applyView()
    }
    const pad = 30
    const k = Math.max(0.1, Math.min(1, (box.width - pad * 2) / layout.width, (box.height - pad * 2) / layout.height))
    this.view = { k, x: (box.width - layout.width * k) / 2, y: Math.max(pad, (box.height - layout.height * k) / 2) }
    this.applyView()
  }

  private applyView(): void {
    this.world.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`)
  }

  private wireCanvas(canvas: HTMLDivElement): void {
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null
    const tableAt = (target: EventTarget | null) => ((target as Element | null)?.closest?.('.dbtable') as SVGGElement | null)?.dataset.id ?? null
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false }
      canvas.setPointerCapture?.(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      if (drag.moved) {
        this.view.x = drag.vx + dx
        this.view.y = drag.vy + dy
        this.applyView()
      }
    })
    canvas.addEventListener('pointerup', (e) => {
      const wasDrag = drag?.moved
      drag = null
      if (wasDrag) return
      this.select(tableAt(document.elementFromPoint(e.clientX, e.clientY) ?? e.target))
    })
    canvas.addEventListener('dblclick', (e) => {
      const t = this.schema?.tables.find((x) => x.id === tableAt(e.target))
      if (t?.path) this.hooks.openAt(t.path, (t.line ?? 1) - 1)
    })
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const box = this.svgEl.getBoundingClientRect()
      const px = e.clientX - box.left
      const py = e.clientY - box.top
      const k = Math.min(3, Math.max(0.1, this.view.k * Math.pow(1.0015, -e.deltaY)))
      this.view.x = px - ((px - this.view.x) * k) / this.view.k
      this.view.y = py - ((py - this.view.y) * k) / this.view.k
      this.view.k = k
      this.applyView()
    }, { passive: false })
  }

  // ---------- the side ----------

  private renderSide(): void {
    const s = this.schema
    if (!s) return this.side.replaceChildren()
    const t = this.selected ? s.tables.find((x) => x.id === this.selected) : undefined
    this.side.replaceChildren(...(t ? this.details(s, t) : this.overview(s)))
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

  private overview(s: DbSchema): HTMLElement[] {
    return [
      el('div', 'graph-side-intro', 'Tables found in the code (models and CREATE TABLE) and in SQLite files it opens. Click a table for details, double-click to open its code.'),
      ...this.section('Connections', s.connections.map((c) => this.item(
        c.target ?? '(address built at run time)',
        `${KIND[c.kind] ?? c.kind} · ${c.library} · ${c.func ? `${c.module}.${c.func}` : c.module}${c.error ? ` · couldn't read it: ${c.error}` : c.file ? ' · tables read from the file' : ''}`,
        () => this.hooks.openAt(c.path, c.line - 1))), 'None found.'),
      ...this.section('Tables', s.tables.map((t) => this.item(t.name, `${t.columns.length} column${t.columns.length === 1 ? '' : 's'}${t.model ? ` · ${t.model}` : ''}`, () => this.select(t.id))))
    ]
  }

  private details(s: DbSchema, t: DbTable): HTMLElement[] {
    const out: HTMLElement[] = [el('div', 'graph-side-title', t.name)]
    const where = t.model
      ? `Defined by the ${t.model} model (${FRAMEWORK[t.framework ?? ''] ?? t.framework}) in ${t.path}`
      : t.sources.includes('sql') ? `Created by SQL in ${t.path}` : 'Only in the database file: nothing in the code creates it.'
    out.push(el('div', 'graph-side-sub', where))
    if (t.path) {
      const actions = el('div', 'graph-side-actions')
      const open = el('button', 'graph-button', 'Open')
      open.addEventListener('click', () => this.hooks.openAt(t.path!, (t.line ?? 1) - 1))
      actions.append(open)
      out.push(actions)
    }
    if (t.sources.includes('database') && t.path) out.push(el('div', 'graph-side-intro', 'Also in the database file the code opens.'))
    const name = (id: string) => s.tables.find((x) => x.id === id)?.name ?? id
    const kindText = { fk: 'foreign key', many: 'many-to-many', relationship: 'relationship' } as const
    out.push(
      ...this.section('Columns', t.columns.map((c) => this.item(c.name, [c.type, c.pk ? 'key' : '', c.fk ? `→ ${c.fk}` : '', c.unique ? 'unique' : '', c.implicit ? 'added by the framework' : ''].filter(Boolean).join(' · '), () => {
        if (t.path) this.hooks.openAt(t.path, (t.line ?? 1) - 1)
      }, c.pk ? 'pk' : ''))),
      ...this.section('Refers to', s.relations.filter((r) => r.from === t.id).map((r) => this.item(name(r.to), r.column ? `${r.column} · ${kindText[r.kind]}` : kindText[r.kind], () => this.select(r.to)))),
      ...this.section('Referred to by', s.relations.filter((r) => r.to === t.id && r.from !== t.id).map((r) => this.item(name(r.from), r.column ? `${r.column} · ${kindText[r.kind]}` : kindText[r.kind], () => this.select(r.from)))),
      ...(t.model ? this.section('Used in', t.usedBy.map((id) => this.item(funcLabel(id), '', () => this.hooks.openFunction(id))), `Nothing in the project names ${t.model} yet.`) : [])
    )
    return out
  }
}
