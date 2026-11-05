/**
 * The autocomplete popup.
 *
 * Opens when you type a name or a '.', or on Ctrl+Space. The server is asked
 * once; typing more letters just filters that list locally (unless the server
 * said its list was incomplete). ↑/↓ choose, Enter/Tab insert, Esc closes.
 */
import type { Editor } from './editor/editor'
import type { Doc } from './editor/document'
import type { PythonLanguage } from './lsp/python'
import { completionEdit, filterCompletions, kindIcon, wordStartAt, type CompletionItem } from './lsp/completionLogic'

const MAX_SHOWN = 200
const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch)

export class Completion {
  private readonly root: HTMLDivElement
  private readonly list: HTMLDivElement
  private readonly details: HTMLDivElement
  private items: CompletionItem[] = []
  private shown: CompletionItem[] = []
  private selected = 0
  private open = false
  private incomplete = false
  /** Where the word being completed starts. */
  private line = 0
  private startCol = 0
  private doc: Doc | null = null
  private generation = 0
  private resolveTimer: number | undefined

  constructor(
    private readonly editor: Editor,
    private readonly python: PythonLanguage,
    private readonly activeDoc: () => Doc | null
  ) {
    this.root = document.createElement('div')
    this.root.className = 'completion'
    this.root.hidden = true
    this.list = document.createElement('div')
    this.list.className = 'completion-list'
    this.list.setAttribute('role', 'listbox')
    this.details = document.createElement('div')
    this.details.className = 'completion-details'
    this.root.append(this.list, this.details)
    document.body.append(this.root)
    // Clicking inside the popup must not steal focus from the editor.
    this.root.addEventListener('mousedown', (e) => e.preventDefault())
    document.addEventListener('mousedown', (e) => {
      if (this.open && !this.root.contains(e.target as Node)) this.close()
    }, true)
  }

  get isOpen(): boolean {
    return this.open
  }

  /** The active tab changed: a popup for another file makes no sense, so close it. */
  syncDoc(): void {
    if (this.open && this.activeDoc() !== this.doc) this.close()
  }

  /** Ctrl+Space. */
  invoke(): void {
    void this.request()
  }

  /** The user typed `text` in the editor. */
  onType(text: string): void {
    const doc = this.activeDoc()
    if (!doc || !/\.pyi?$/i.test(doc.path)) return
    const last = text[text.length - 1]
    if (this.open) {
      if (last === '.') void this.request('.')
      else if (text.length === 1 && isWordChar(last)) {
        if (this.incomplete) void this.request()
        else this.refilter()
      } else this.close()
      return
    }
    if (last === '.') void this.request('.')
    else if (text.length === 1 && isWordChar(last)) {
      // Don't pop up for numbers like "42".
      const pos = this.editor.getCursor()
      const lineText = doc.buffer.getLine(pos.line)
      const start = wordStartAt(lineText, pos.col)
      if (!/[0-9]/.test(lineText[start])) void this.request()
    }
  }

  /** Any edit (including Backspace): keep the list in sync, or close it. */
  onEdit(): void {
    if (this.open) this.refilter()
  }

  /** Keys while the popup is open. Returns true if handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey && e.key === ' ') {
      this.invoke()
      return true
    }
    if (!this.open) return false
    switch (e.key) {
      case 'ArrowDown': this.move(1); return true
      case 'ArrowUp': this.move(-1); return true
      case 'PageDown': this.move(8); return true
      case 'PageUp': this.move(-8); return true
      case 'Enter':
      case 'Tab':
        if (e.shiftKey || e.ctrlKey || e.altKey) return false
        this.accept(this.selected)
        return true
      case 'Escape': this.close(); return true
      case 'ArrowLeft': case 'ArrowRight': case 'Home': case 'End':
        this.close()
        return false // let the editor move the cursor too
    }
    return false
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.generation++
    this.root.hidden = true
    window.clearTimeout(this.resolveTimer)
  }

  private async request(trigger?: string): Promise<void> {
    const doc = this.activeDoc()
    if (!doc) return
    const pos = this.editor.getCursor()
    const gen = ++this.generation
    let result
    try {
      result = await this.python.completion(doc, pos, trigger)
    } catch {
      return // server busy/restarting: just don't show anything
    }
    if (gen !== this.generation || this.activeDoc() !== doc) return // something newer happened
    const now = this.editor.getCursor()
    if (now.line !== pos.line) return
    this.items = result.items
    this.incomplete = result.incomplete
    this.doc = doc
    this.line = now.line
    this.startCol = wordStartAt(doc.buffer.getLine(now.line), now.col)
    this.open = true
    this.refilter()
  }

  private refilter(): void {
    const doc = this.activeDoc()
    const pos = this.editor.getCursor()
    if (!doc || doc !== this.doc || pos.line !== this.line || pos.col < this.startCol) {
      this.close()
      return
    }
    const lineText = doc.buffer.getLine(pos.line)
    if (wordStartAt(lineText, pos.col) !== this.startCol) {
      this.close()
      return
    }
    const prefix = lineText.slice(this.startCol, pos.col)
    this.shown = filterCompletions(this.items, prefix).slice(0, MAX_SHOWN)
    // Nothing left, or the only suggestion is exactly what's already typed: nothing to offer.
    if (this.shown.length === 0 || (this.shown.length === 1 && (this.shown[0].insertText ?? this.shown[0].label) === prefix)) {
      this.root.hidden = true
      if (this.shown.length === 0) this.close()
      return
    }
    this.selected = 0
    this.render()
    this.place()
  }

  private render(): void {
    const rows = this.shown.map((item, i) => {
      const row = document.createElement('div')
      row.className = 'completion-item'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === this.selected))
      const { icon, name } = kindIcon(item.kind)
      const k = document.createElement('span')
      k.className = `completion-kind kind-${name}`
      k.textContent = icon
      k.title = name
      const label = document.createElement('span')
      label.className = 'completion-label'
      label.textContent = item.label
      row.append(k, label)
      row.addEventListener('mousemove', () => {
        if (this.selected !== i) this.select(i)
      })
      row.addEventListener('click', () => this.accept(i))
      return row
    })
    this.list.replaceChildren(...rows)
    this.root.hidden = false
    this.showDetails()
  }

  private place(): void {
    const at = this.editor.coordsAt({ line: this.line, col: this.startCol })
    const box = this.root.getBoundingClientRect()
    const left = Math.max(4, Math.min(at.left - 24, window.innerWidth - box.width - 4))
    const below = at.bottom + 2
    const top = below + box.height > window.innerHeight - 4 ? at.top - box.height - 2 : below
    this.root.style.left = `${left}px`
    this.root.style.top = `${Math.max(4, top)}px`
  }

  private move(delta: number): void {
    if (this.shown.length === 0) return
    let next = this.selected + delta
    if (Math.abs(delta) === 1) next = (next + this.shown.length) % this.shown.length // wrap with arrows
    else next = Math.max(0, Math.min(this.shown.length - 1, next))
    this.select(next)
  }

  private select(i: number): void {
    this.selected = i
    this.list.querySelectorAll('.completion-item').forEach((row, j) => row.setAttribute('aria-selected', String(j === i)))
    this.list.children[i]?.scrollIntoView({ block: 'nearest' })
    this.showDetails()
  }

  /** Show type/docs for the selected item, fetching them from the server if needed. */
  private showDetails(): void {
    const item = this.shown[this.selected]
    window.clearTimeout(this.resolveTimer)
    const render = (it: CompletionItem) => {
      this.details.replaceChildren()
      if (it.detail) {
        const d = document.createElement('div')
        d.className = 'completion-detail'
        d.textContent = it.detail
        this.details.append(d)
      }
      if (it.documentation) {
        const d = document.createElement('div')
        d.className = 'completion-doc'
        d.textContent = it.documentation.replace(/```\w*\n?/g, '').trim()
        this.details.append(d)
      }
      this.details.hidden = !it.detail && !it.documentation
    }
    if (!item) {
      this.details.hidden = true
      return
    }
    render(item)
    if (item.detail || item.documentation) return
    const gen = this.generation
    this.resolveTimer = window.setTimeout(() => {
      void this.python.resolveCompletion(item).then((full) => {
        if (gen !== this.generation || this.shown[this.selected] !== item) return
        Object.assign(item, { detail: full.detail, documentation: full.documentation })
        render(item)
      }, () => {})
    }, 80)
  }

  private accept(i: number): void {
    const item = this.shown[i]
    const doc = this.activeDoc()
    if (!item || !doc) return this.close()
    const pos = this.editor.getCursor()
    const edit = completionEdit(item, doc.buffer.getLine(pos.line), pos)
    this.close()
    this.editor.runEdit((b) => {
      b.delete(edit.start, edit.end)
      return b.insert(edit.start, edit.text)
    })
  }
}
