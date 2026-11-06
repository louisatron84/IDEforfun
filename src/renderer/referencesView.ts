/**
 * The References tab in the bottom panel (Shift+F12): every place a symbol is
 * used, grouped by file, with the line it's on. Click one to go there.
 */
import type { Location } from './lsp/navigation'

export class ReferencesView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private generation = 0

  constructor(
    private readonly open: (loc: Location) => void,
    private readonly relative: (path: string) => string
  ) {
    this.body = document.createElement('div')
    this.body.className = 'problems-view references-view'
    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    this.message('Put the cursor on a name and press Shift+F12 to list everywhere it is used.')
  }

  message(text: string): void {
    this.generation++
    const el = document.createElement('div')
    el.className = 'problems-empty'
    el.textContent = text
    this.body.replaceChildren(el)
  }

  /** Show results; `lineText` gives the text of a line (for the preview). */
  async show(
    name: string, locations: Location[], lineText: (path: string, line: number) => Promise<string>,
    /** What the results are: e.g. "implementation" (default "reference"). */
    what = 'reference'
  ): Promise<void> {
    const gen = ++this.generation
    const plural = what.endsWith('s') ? `${what}es` : `${what}s`
    if (!locations.length) return this.message(`No ${plural} ${what === 'reference' ? 'to' : 'of'} "${name}" found.`)
    const byFile = new Map<string, Location[]>()
    for (const l of locations) byFile.set(l.path, [...(byFile.get(l.path) ?? []), l])
    const head = document.createElement('div')
    head.className = 'references-summary'
    head.textContent = `${locations.length} ${locations.length === 1 ? what : plural} ${what === 'reference' ? 'to' : 'of'} "${name}" in ${byFile.size} file${byFile.size === 1 ? '' : 's'}`
    const groups: HTMLElement[] = []
    for (const [path, list] of byFile) {
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
      for (const loc of list) {
        const row = document.createElement('button')
        row.className = 'problem reference'
        const where = document.createElement('span')
        where.className = 'search-line-no'
        where.textContent = String(loc.start.line + 1)
        const text = document.createElement('span')
        text.className = 'problem-message reference-text'
        let line = ''
        try {
          line = await lineText(path, loc.start.line)
        } catch { /* file unreadable: show without a preview */ }
        if (gen !== this.generation) return // newer results arrived
        // The line, trimmed, with the reference itself highlighted.
        const indent = line.length - line.trimStart().length
        const from = Math.max(0, loc.start.col - indent)
        const to = loc.end.line === loc.start.line ? Math.max(from, loc.end.col - indent) : line.length - indent
        const trimmed = line.trim()
        const mark = document.createElement('mark')
        mark.textContent = trimmed.slice(from, to)
        text.append(trimmed.slice(0, from), mark, trimmed.slice(to))
        row.title = `${this.relative(path)}:${loc.start.line + 1}`
        row.append(where, text)
        row.addEventListener('click', () => this.open(loc))
        group.append(row)
      }
      groups.push(group)
    }
    if (gen !== this.generation) return
    this.body.replaceChildren(head, ...groups)
  }
}
