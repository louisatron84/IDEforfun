/**
 * The History tab in the bottom panel: commits newest first with a graph of
 * branches and merges, branch/tag labels, author and age. Click a commit to
 * see its message and files; click a file to see what the commit changed.
 * Can show every branch, the current one, or just the open file's history.
 */
import { graphLayout, timeAgo, type Commit, type GraphRow } from '../shared/history'
import type { Repo } from './gitView'

export interface HistoryHooks {
  repo(): Repo | null
  /** The open file, relative to the repository (for "this file only"). */
  activeFile(): string | null
  showCommitFile(repo: Repo, sha: string, subject: string, path: string): void
  openFile(repoRelPath: string): void
}

const PAGE = 300
const LANE = 14
const ROW = 24
/** Lane colours come from the theme (--lane-1 … --lane-8 in theme.css). */
const LANES = 8
let laneCache: { theme: string | undefined; colours: string[] } | null = null
/** Read once per theme (getComputedStyle is too slow to call for every row). */
function laneColours(): string[] {
  const theme = document.documentElement.dataset.theme
  if (laneCache?.theme !== theme) {
    const css = getComputedStyle(document.documentElement)
    laneCache = { theme, colours: Array.from({ length: LANES }, (_, i) => css.getPropertyValue(`--lane-${i + 1}`).trim() || 'gray') }
  }
  return laneCache!.colours
}
const color = (col: number) => laneColours()[col % LANES]

export class HistoryView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly list: HTMLDivElement
  private readonly details: HTMLDivElement
  private commits: Commit[] = []
  private rows: GraphRow[] = []
  private all = true
  private file: string | null = null
  private selected: string | null = null
  private more = false
  private generation = 0
  private detailGeneration = 0
  private readonly scopeButton: HTMLButtonElement
  private readonly fileButton: HTMLButtonElement

  constructor(private readonly hooks: HistoryHooks) {
    this.body = document.createElement('div')
    this.body.className = 'history-view'
    this.list = document.createElement('div')
    this.list.className = 'history-list'
    this.list.setAttribute('role', 'listbox')
    this.details = document.createElement('div')
    this.details.className = 'history-details'
    this.body.append(this.list, this.details)

    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    this.scopeButton = this.button('All branches', 'Show every branch, or only the current one', () => {
      this.all = !this.all
      void this.load()
    })
    this.fileButton = this.button('This file', "Show only the open file's history", () => {
      this.file = this.file ? null : this.hooks.activeFile()
      void this.load()
    })
    this.button('⟳', 'Refresh', () => void this.load())
    this.showMessage('Open a folder that is a git repository to see its history.')
  }

  private button(text: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.textContent = text
    b.title = title
    b.addEventListener('click', fn)
    this.actions.append(b)
    return b
  }

  private showMessage(text: string): void {
    const el = document.createElement('div')
    el.className = 'problems-empty'
    el.textContent = text
    this.list.replaceChildren(el)
    this.details.replaceChildren()
  }

  /** Show one file's history (Git → File History). */
  async showFile(path: string): Promise<void> {
    this.file = path
    await this.load()
  }

  /** (Re)load the first page. */
  async load(): Promise<void> {
    this.commits = []
    this.selected = null
    await this.fetch()
  }

  private async fetch(): Promise<void> {
    const repo = this.hooks.repo()
    this.scopeButton.textContent = this.all ? 'All branches' : 'Current branch'
    this.fileButton.textContent = this.file ? `File: ${this.file.split('/').pop()} ×` : 'This file'
    this.fileButton.title = this.file ? `Showing ${this.file} only. Click to show everything.` : "Show only the open file's history"
    if (!repo) return this.showMessage("This folder isn't a git repository.")
    const gen = ++this.generation
    if (!this.commits.length) this.showMessage('Loading history…')
    const res = await window.api.gitLog(repo.root, { all: this.all && !this.file, path: this.file ?? undefined, limit: PAGE, skip: this.commits.length })
    if (gen !== this.generation) return
    if (!res.ok) return this.showMessage(`Couldn't read the history: ${res.error ?? ''}`)
    this.commits.push(...res.commits)
    this.more = res.commits.length === PAGE
    if (!this.commits.length) return this.showMessage(this.file ? 'This file has no commits yet.' : 'No commits yet.')
    this.rows = graphLayout(this.commits)
    this.render()
  }

  private render(): void {
    const lanes = Math.max(1, ...this.rows.map((r) => Math.max(r.before.length, r.after.length, r.col + 1)))
    const width = Math.min(lanes, 12) * LANE + 6
    const items = this.commits.map((c, i) => this.renderRow(c, this.rows[i], width))
    if (this.more) {
      const more = document.createElement('button')
      more.className = 'history-more'
      more.textContent = 'Load more commits'
      more.addEventListener('click', () => void this.fetch())
      items.push(more)
    }
    this.list.replaceChildren(...items)
  }

  private renderRow(c: Commit, row: GraphRow, width: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'history-row' + (c.sha === this.selected ? ' selected' : '')
    el.setAttribute('role', 'option')
    el.append(this.graph(row, width))
    const text = document.createElement('div')
    text.className = 'history-text'
    for (const ref of c.refs) {
      const tag = document.createElement('span')
      const head = ref.startsWith('HEAD -> ')
      const name = head ? ref.slice(8) : ref
      tag.className = 'history-ref' + (head ? ' head' : name.startsWith('tag: ') ? ' tag' : name.includes('/') ? ' remote' : '')
      tag.textContent = name.replace(/^tag: /, '🏷 ')
      text.append(tag)
    }
    const subject = document.createElement('span')
    subject.className = 'history-subject'
    subject.textContent = c.subject
    text.append(subject)
    const meta = document.createElement('span')
    meta.className = 'history-meta'
    meta.textContent = `${c.author} · ${timeAgo(c.time)}`
    meta.title = new Date(c.time * 1000).toLocaleString()
    el.append(text, meta)
    el.title = `${c.sha.slice(0, 10)}  ${c.subject}`
    el.addEventListener('click', () => void this.select(c))
    return el
  }

  /** The graph cell of one row, as SVG lines and a dot. */
  private graph(row: GraphRow, width: number): SVGSVGElement {
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(ROW))
    svg.classList.add('history-graph')
    const x = (col: number) => 7 + Math.min(col, 11) * LANE
    const mid = ROW / 2
    const line = (x1: number, y1: number, x2: number, y2: number, col: number) => {
      const p = document.createElementNS(NS, 'path')
      // Straight when vertical, a smooth curve when changing column.
      p.setAttribute('d', x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`)
      p.setAttribute('stroke', color(col))
      p.setAttribute('stroke-width', '2')
      p.setAttribute('fill', 'none')
      svg.append(p)
    }
    // Lanes passing by this commit.
    for (let i = 0; i < row.before.length; i++) {
      if (i === row.col || row.joins.includes(i) || row.before[i] === null) continue
      const j = row.after.indexOf(row.before[i]!)
      if (j !== -1) line(x(i), 0, x(j), ROW, i)
    }
    // Into the dot: its own lane from above, and branches joining here.
    if (row.before[row.col] !== null && row.before[row.col] !== undefined) line(x(row.col), 0, x(row.col), mid, row.col)
    for (const j of row.joins) line(x(j), 0, x(row.col), mid, j)
    // Out of the dot: one line per parent.
    row.parentCols.forEach((pc, k) => line(x(row.col), mid, x(pc), ROW, k === 0 ? row.col : pc))
    const dot = document.createElementNS(NS, 'circle')
    dot.setAttribute('cx', String(x(row.col)))
    dot.setAttribute('cy', String(mid))
    dot.setAttribute('r', row.parentCols.length > 1 ? '3.5' : '4')
    dot.setAttribute('fill', row.parentCols.length > 1 ? 'var(--bg)' : color(row.col))
    dot.setAttribute('stroke', color(row.col))
    dot.setAttribute('stroke-width', '2')
    svg.append(dot)
    return svg
  }

  private async select(c: Commit): Promise<void> {
    const repo = this.hooks.repo()
    if (!repo) return
    this.selected = c.sha
    for (const r of this.list.querySelectorAll('.history-row')) r.classList.toggle('selected', (r as HTMLElement).title.startsWith(c.sha.slice(0, 10)))
    const gen = ++this.detailGeneration
    this.details.replaceChildren(Object.assign(document.createElement('div'), { className: 'problems-empty', textContent: 'Loading…' }))
    const d = await window.api.gitCommitDetails(repo.root, c.sha)
    if (gen !== this.detailGeneration) return
    const head = document.createElement('div')
    head.className = 'history-detail-head'
    const sha = document.createElement('code')
    sha.textContent = c.sha.slice(0, 10)
    sha.title = 'Click to copy the full commit id'
    sha.addEventListener('click', () => void navigator.clipboard.writeText(c.sha))
    const who = document.createElement('span')
    who.textContent = ` ${c.author}, ${new Date(c.time * 1000).toLocaleString()}`
    head.append(sha, who)
    const msg = document.createElement('pre')
    msg.className = 'history-message'
    msg.textContent = d.ok ? d.message : d.error ?? ''
    const files = document.createElement('div')
    files.className = 'history-files'
    for (const f of d.files) {
      const row = document.createElement('button')
      row.className = 'history-file'
      const st = document.createElement('span')
      st.className = `git-letter kind-${f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'R' ? 'renamed' : 'modified'}`
      st.textContent = f.status
      const name = document.createElement('span')
      name.textContent = f.from ? `${f.from} → ${f.path}` : f.path
      row.append(st, name)
      row.title = 'Show what this commit changed in the file'
      row.addEventListener('click', () => this.hooks.showCommitFile(repo, c.sha, c.subject, f.path))
      files.append(row)
    }
    if (!d.files.length && d.ok) files.append(Object.assign(document.createElement('div'), { className: 'problems-empty', textContent: c.parents.length > 1 ? 'Merge commit (no changes of its own shown).' : 'No files changed.' }))
    this.details.replaceChildren(head, msg, files)
  }
}
