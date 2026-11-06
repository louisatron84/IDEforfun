/**
 * The Problems tab in the bottom panel: every error and warning from the
 * language server, grouped by file. Clicking one jumps to it.
 */
import type { Diagnostic } from './lsp/server'

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' } as const
const ICON = { 1: '✖', 2: '⚠', 3: 'ℹ', 4: '·' } as const

export class ProblemsView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private status = ''

  constructor(
    private readonly onOpen: (path: string, d: Diagnostic) => void,
    private readonly relative: (path: string) => string
  ) {
    this.body = document.createElement('div')
    this.body.className = 'problems-view'
    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
  }

  /** A message shown when there is nothing to list (e.g. "starting Pyright…"). */
  setStatus(text: string): void {
    this.status = text
  }

  /** Redraw; returns the number of errors + warnings (for the tab title). */
  render(files: [string, Diagnostic[]][]): number {
    const shown = files
      .map(([path, list]) => [path, list.filter((d) => d.severity <= 3)] as const)
      .filter(([, list]) => list.length > 0)
      .sort((a, b) => this.relative(a[0]).localeCompare(this.relative(b[0])))
    let count = 0
    const groups = shown.map(([path, list]) => {
      const group = document.createElement('div')
      group.className = 'problem-file'
      const header = document.createElement('div')
      header.className = 'problem-file-header'
      header.textContent = this.relative(path)
      const n = document.createElement('span')
      n.className = 'search-file-count'
      n.textContent = String(list.length)
      header.append(n)
      group.append(header)
      const sorted = [...list].sort((a, b) => a.severity - b.severity || a.start.line - b.start.line || a.start.col - b.start.col)
      for (const d of sorted) {
        if (d.severity <= 2) count++
        const row = document.createElement('button')
        row.className = `problem sev-${d.severity}`
        const icon = document.createElement('span')
        icon.className = 'problem-icon'
        icon.textContent = ICON[d.severity]
        icon.setAttribute('aria-label', SEVERITY[d.severity])
        const msg = document.createElement('span')
        msg.className = 'problem-message'
        msg.textContent = d.message.split('\n')[0]
        const where = document.createElement('span')
        where.className = 'problem-where'
        where.textContent = `${d.code ? d.code + '  ' : ''}[${d.start.line + 1}, ${d.start.col + 1}]`
        row.title = d.message
        row.append(icon, msg, where)
        row.addEventListener('click', () => this.onOpen(path, d))
        group.append(row)
      }
      return group
    })
    if (groups.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'problems-empty'
      empty.textContent = this.status || 'No problems found in open Python files.'
      this.body.replaceChildren(empty)
    } else this.body.replaceChildren(...groups)
    return count
  }
}
