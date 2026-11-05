/**
 * Search across the whole project (Ctrl+Shift+F), shown in the sidebar.
 * Results are grouped by file; clicking one opens the file with the match selected.
 * The search itself runs in the main process (it reads files from disk).
 */
import type { FindOptions } from '../shared/regex'
import type { ProjectSearchResult } from '../shared/api'

const DEBOUNCE_MS = 250

export class SearchView {
  readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly status: HTMLDivElement
  private readonly results: HTMLDivElement
  private readonly opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false }
  private timer: number | undefined
  /** Incremented per search, so a slow older search can't overwrite newer results. */
  private generation = 0

  constructor(
    private readonly getRoot: () => string | null,
    private readonly openMatch: (path: string, line: number, col: number, length: number) => void
  ) {
    this.root = document.createElement('div')
    this.root.className = 'search-view'
    const bar = document.createElement('div')
    bar.className = 'search-bar'
    this.input = document.createElement('input')
    this.input.className = 'search-input'
    this.input.placeholder = 'Search in project'
    this.input.setAttribute('aria-label', 'Search in project')
    this.input.spellcheck = false
    bar.append(this.input)
    for (const [opt, label, title] of [
      ['caseSensitive', 'Aa', 'Match case (Alt+C)'],
      ['wholeWord', 'ab', 'Whole word (Alt+W)'],
      ['regex', '.*', 'Regular expression (Alt+R)']
    ] as const) {
      const b = document.createElement('button')
      b.className = 'toggle'
      b.dataset.opt = opt
      b.title = title
      b.textContent = label
      if (opt === 'wholeWord') b.style.textDecoration = 'underline'
      b.setAttribute('aria-pressed', 'false')
      b.addEventListener('mousedown', (e) => e.preventDefault()) // keep focus in the input
      b.addEventListener('click', () => this.toggle(opt))
      bar.append(b)
    }
    this.status = document.createElement('div')
    this.status.className = 'search-status'
    this.status.setAttribute('aria-live', 'polite')
    this.results = document.createElement('div')
    this.results.className = 'search-results'
    this.root.append(bar, this.status, this.results)

    this.input.addEventListener('input', () => this.schedule())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.run()
      } else if (e.altKey && ['c', 'w', 'r'].includes(e.key.toLowerCase())) {
        e.preventDefault()
        const map: Record<string, keyof FindOptions> = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' }
        this.toggle(map[e.key.toLowerCase()])
      }
    })
  }

  /** Focus the search box, optionally starting with some text (e.g. the editor selection). */
  focus(initial?: string): void {
    if (initial && !initial.includes('\n')) {
      this.input.value = initial
      void this.run()
    }
    this.input.focus()
    this.input.select()
  }

  /** Re-run the current search (e.g. after files were saved). */
  refresh(): void {
    if (this.input.value) void this.run()
  }

  private toggle(opt: keyof FindOptions): void {
    this.opts[opt] = !this.opts[opt]
    this.root.querySelector(`[data-opt="${opt}"]`)!.setAttribute('aria-pressed', String(this.opts[opt]))
    void this.run()
  }

  private schedule(): void {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.run(), DEBOUNCE_MS)
  }

  private async run(): Promise<void> {
    window.clearTimeout(this.timer)
    const gen = ++this.generation
    const root = this.getRoot()
    const query = this.input.value
    if (!root) {
      this.status.textContent = 'Open a folder to search it.'
      this.results.replaceChildren()
      return
    }
    if (!query) {
      this.status.textContent = ''
      this.results.replaceChildren()
      return
    }
    this.status.textContent = 'Searching…'
    const result = await window.api.searchProject(root, query, { ...this.opts })
    if (gen !== this.generation) return // a newer search started meanwhile
    this.render(result)
  }

  private render(r: ProjectSearchResult): void {
    this.input.classList.toggle('invalid', !!r.error)
    if (r.error) {
      this.status.textContent = `Invalid regex: ${r.error}`
      this.results.replaceChildren()
      return
    }
    const fileWord = r.files.length === 1 ? 'file' : 'files'
    const resultWord = r.total === 1 ? 'result' : 'results'
    this.status.textContent = r.total === 0
      ? 'No results'
      : `${r.total}${r.truncated ? '+' : ''} ${resultWord} in ${r.files.length} ${fileWord}` +
        (r.truncated ? ' (stopped early, narrow the search)' : '')

    const groups = r.files.map((file) => {
      const group = document.createElement('div')
      group.className = 'search-file'
      const header = document.createElement('button')
      header.className = 'search-file-header'
      header.setAttribute('aria-expanded', 'true')
      const slash = file.rel.lastIndexOf('/')
      const name = document.createElement('span')
      name.className = 'search-file-name'
      name.textContent = file.rel.slice(slash + 1)
      const dir = document.createElement('span')
      dir.className = 'search-file-dir'
      dir.textContent = slash > 0 ? file.rel.slice(0, slash) : ''
      const count = document.createElement('span')
      count.className = 'search-file-count'
      count.textContent = String(file.matches.length)
      header.append(name, dir, count)
      header.title = file.path

      const list = document.createElement('div')
      list.className = 'search-matches'
      header.addEventListener('click', () => {
        list.hidden = !list.hidden
        header.setAttribute('aria-expanded', String(!list.hidden))
      })
      for (const m of file.matches) {
        const row = document.createElement('button')
        row.className = 'search-match'
        row.title = `Line ${m.line + 1}`
        const { text, start } = m.preview
        // Text nodes + <mark>, never innerHTML: file contents are untrusted.
        const mark = document.createElement('mark')
        mark.textContent = text.slice(start, start + m.length)
        row.append(text.slice(0, start), mark, text.slice(start + m.length))
        row.addEventListener('click', () => this.openMatch(file.path, m.line, m.col, m.length))
        list.append(row)
      }
      group.append(header, list)
      return group
    })
    this.results.replaceChildren(...groups)
  }
}
