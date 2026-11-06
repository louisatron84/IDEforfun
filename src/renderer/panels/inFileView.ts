/**
 * In this file: the current file's functions and classes, each with a short
 * note on what it reaches outside the file and who uses it. Click to jump.
 */
import type { ProjectGraph } from '../../shared/projectGraph'
import { fileSummary } from './whereModel'

export class InFileView {
  readonly body: HTMLDivElement

  constructor(private readonly goTo: (line: number) => void) {
    this.body = document.createElement('div')
    this.body.className = 'infile-view'
  }

  set(graph: ProjectGraph | null, module: string | null, message: string): void {
    if (!graph || !module) {
      const note = document.createElement('div')
      note.className = 'where-note'
      note.textContent = message
      this.body.replaceChildren(note)
      return
    }
    const items = fileSummary(graph, module)
    if (!items.length) {
      const note = document.createElement('div')
      note.className = 'where-note'
      note.textContent = 'No functions or classes in this file.'
      this.body.replaceChildren(note)
      return
    }
    this.body.replaceChildren(...items.map((s) => {
      const row = document.createElement('div')
      row.className = 'infile-item'
      const name = document.createElement('span')
      name.className = 'infile-name'
      name.textContent = `${s.kind === 'class' ? 'C' : 'ƒ'} ${s.qual}`
      const summary = document.createElement('span')
      summary.className = 'infile-summary'
      summary.textContent = s.summary
      row.title = `${s.qual} (line ${s.line})${s.summary ? `\n${s.summary}` : ''}`
      row.append(name, summary)
      row.addEventListener('click', () => this.goTo(s.line - 1))
      return row
    }))
  }
}
