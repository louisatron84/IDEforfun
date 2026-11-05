/**
 * The find/replace bar (Ctrl+F / Ctrl+H), floating over the top-right of the editor.
 *
 * All matches in the file are highlighted; the "current" match is selected in
 * the editor. Enter / Shift+Enter go to the next / previous match.
 */
import type { Editor } from './editor/editor'
import type { FindOptions, Match } from './editor/find'
import { escapeRegExp, findMatches, matchIndexFrom, replaceAll, replacementFor } from './editor/find'
import { comparePositions } from './editor/textBuffer'

export class FindBar {
  private readonly root: HTMLDivElement
  private readonly findInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly replaceRow: HTMLDivElement
  private readonly count: HTMLSpanElement
  private readonly opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false }
  private matches: Match[] = []
  private current = -1

  constructor(container: HTMLElement, private readonly editor: Editor) {
    this.root = document.createElement('div')
    this.root.className = 'find-bar'
    this.root.hidden = true
    this.root.innerHTML = `
      <div class="find-row">
        <input class="find-input" type="text" placeholder="Find" aria-label="Find" spellcheck="false" />
        <button class="toggle" data-opt="caseSensitive" title="Match case (Alt+C)">Aa</button>
        <button class="toggle" data-opt="wholeWord" title="Whole word (Alt+W)"><u>ab</u></button>
        <button class="toggle" data-opt="regex" title="Regular expression (Alt+R)">.*</button>
        <span class="find-count" aria-live="polite"></span>
        <button class="icon" data-act="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
        <button class="icon" data-act="next" title="Next match (Enter)" aria-label="Next match">↓</button>
        <button class="icon" data-act="toggle-replace" title="Toggle replace (Ctrl+H)" aria-label="Toggle replace">⇄</button>
        <button class="icon" data-act="close" title="Close (Escape)" aria-label="Close find">×</button>
      </div>
      <div class="replace-row" hidden>
        <input class="replace-input" type="text" placeholder="Replace" aria-label="Replace" spellcheck="false" />
        <button data-act="replace" title="Replace (Enter)">Replace</button>
        <button data-act="replace-all" title="Replace all (Ctrl+Alt+Enter)">All</button>
      </div>`
    container.append(this.root)
    this.findInput = this.root.querySelector('.find-input')!
    this.replaceInput = this.root.querySelector('.replace-input')!
    this.replaceRow = this.root.querySelector('.replace-row')!
    this.count = this.root.querySelector('.find-count')!

    this.findInput.addEventListener('input', () => this.search(true))
    this.root.addEventListener('mousedown', (e) => {
      // Keep focus in the inputs when clicking the bar's buttons.
      if ((e.target as HTMLElement).closest('button')) e.preventDefault()
    })
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button')
      if (!btn) return
      if (btn.dataset.opt) this.toggleOption(btn.dataset.opt as keyof FindOptions)
      else this.action(btn.dataset.act!)
    })
    this.root.addEventListener('keydown', (e) => this.onKeyDown(e))
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Open the bar (with the replace row if `replace`), prefilled with the selected text. */
  open(replace = false): void {
    // Prefill with the selection only when opening; if the bar is already open
    // the selection is usually just the current match, and replacing the query
    // with it would throw away a regex the user typed.
    const selected = this.editor.getSelectedText()
    if (!this.isOpen && selected && !selected.includes('\n')) {
      this.findInput.value = this.opts.regex ? escapeRegExp(selected) : selected
    }
    this.root.hidden = false
    if (replace) this.replaceRow.hidden = false
    const focusReplace = replace && this.findInput.value !== ''
    const input = focusReplace ? this.replaceInput : this.findInput
    input.focus()
    input.select()
    this.search(false)
  }

  close(): void {
    this.root.hidden = true
    this.matches = []
    this.editor.setMatches([])
    this.editor.focus()
  }

  /** The document changed (edit or tab switch): refresh highlights without jumping. */
  refresh(): void {
    if (this.isOpen) this.search(false)
  }

  private search(jump: boolean): void {
    const doc = this.editor.currentDoc
    if (!doc) {
      this.matches = []
      this.updateCount()
      return
    }
    const { matches, error } = findMatches(doc.buffer.getLines(), this.findInput.value, this.opts)
    this.matches = matches
    this.findInput.classList.toggle('invalid', !!error)
    this.findInput.title = error ?? ''
    this.editor.setMatches(matches)
    // Which match is "current": the one selected in the editor, or the next one after the cursor.
    const sel = this.editor.getSelection()
    const start = comparePositions(sel.anchor, sel.head) <= 0 ? sel.anchor : sel.head
    this.current = matchIndexFrom(matches, start, 1)
    if (jump && this.current >= 0) this.selectCurrent()
    this.updateCount()
  }

  private go(direction: 1 | -1): void {
    if (this.matches.length === 0) return
    const sel = this.editor.getSelection()
    const onMatch = this.current >= 0 && this.isSelected(this.matches[this.current])
    if (onMatch) {
      this.current = (this.current + direction + this.matches.length) % this.matches.length
    } else {
      this.current = matchIndexFrom(this.matches, sel.head, direction)
    }
    this.selectCurrent()
    this.updateCount()
  }

  private selectCurrent(): void {
    const m = this.matches[this.current]
    if (m) this.editor.select(m.start, m.end)
  }

  private isSelected(m: Match): boolean {
    const s = this.editor.getSelection()
    return comparePositions(s.anchor, m.start) === 0 && comparePositions(s.head, m.end) === 0
  }

  private replaceOne(): void {
    const m = this.matches[this.current]
    if (!m) return
    if (!this.isSelected(m)) {
      this.selectCurrent() // first press selects the match, second replaces it
      return
    }
    const query = this.findInput.value
    this.editor.runEdit((b) => {
      const text = replacementFor(b.getRange(m.start, m.end), query, this.replaceInput.value, this.opts)
      b.delete(m.start, m.end)
      return b.insert(m.start, text)
    })
    // runEdit triggers refresh() via the workspace; then move on to the next match.
    this.search(false)
    if (this.current >= 0) this.selectCurrent()
    this.updateCount()
  }

  private replaceAllMatches(): void {
    if (this.matches.length === 0) return
    const matches = this.matches
    const query = this.findInput.value
    this.editor.runEdit((b) => replaceAll(b, matches, this.replaceInput.value, query, this.opts))
    this.search(false)
  }

  private toggleOption(opt: keyof FindOptions): void {
    this.opts[opt] = !this.opts[opt]
    this.root.querySelector(`[data-opt="${opt}"]`)!.classList.toggle('on', this.opts[opt])
    this.search(true)
  }

  private action(act: string): void {
    if (act === 'next') this.go(1)
    else if (act === 'prev') this.go(-1)
    else if (act === 'close') this.close()
    else if (act === 'toggle-replace') {
      this.replaceRow.hidden = !this.replaceRow.hidden
      ;(this.replaceRow.hidden ? this.findInput : this.replaceInput).focus()
    } else if (act === 'replace') this.replaceOne()
    else if (act === 'replace-all') this.replaceAllMatches()
  }

  private onKeyDown(e: KeyboardEvent): void {
    const inReplace = e.target === this.replaceInput
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (inReplace) {
        if (e.ctrlKey && e.altKey) this.replaceAllMatches()
        else this.replaceOne()
      } else this.go(e.shiftKey ? -1 : 1)
    } else if (e.altKey && ['c', 'w', 'r'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      const map: Record<string, keyof FindOptions> = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' }
      this.toggleOption(map[e.key.toLowerCase()])
    }
  }

  private updateCount(): void {
    if (!this.findInput.value) this.count.textContent = ''
    else if (this.matches.length === 0) this.count.textContent = 'No results'
    else {
      const shown = this.current >= 0 && this.isSelected(this.matches[this.current]) ? this.current + 1 : '?'
      const total = this.matches.length >= 10_000 ? '10000+' : this.matches.length
      this.count.textContent = `${shown} of ${total}`
    }
    this.count.classList.toggle('none', !!this.findInput.value && this.matches.length === 0)
  }
}
