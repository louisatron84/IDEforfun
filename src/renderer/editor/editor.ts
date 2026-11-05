/**
 * Our hand-written editor.
 *
 * How it works:
 * - The text lives in a TextBuffer (the model). Commands in commands.ts change it.
 * - It's drawn as a line-number gutter plus one <pre> holding all the text.
 * - The cursor is a div we position ourselves, using the monospace character width.
 * - Keystrokes go into an invisible <textarea> that follows the cursor. That gives
 *   us typing, paste and IME (e.g. accented chars) from the browser for free;
 *   we read what was typed, insert it into the buffer and clear the textarea.
 *
 * Re-rendering the whole <pre> on each edit is fine for normal files. Rendering
 * only the visible lines is on the checklist for big files.
 */
import type { Position } from './textBuffer'
import { TextBuffer } from './textBuffer'
import * as cmd from './commands'
import type { EditKind } from './history'
import { History } from './history'

const TAB_SIZE = 4
const PAD_TOP = 4 // must match .editor pre padding-top in styles.css
const PAD_LEFT = 12 // must match .editor .content padding-left

export interface EditorOptions {
  /** Called whenever the dirty (unsaved) state changes. */
  onDirtyChange?: (dirty: boolean) => void
}

export class Editor {
  private readonly root: HTMLDivElement
  private readonly gutter: HTMLPreElement
  private readonly textArea: HTMLDivElement
  private readonly content: HTMLPreElement
  private readonly cursorEl: HTMLDivElement
  private readonly input: HTMLTextAreaElement

  private buffer = new TextBuffer('')
  private history = new History(this.buffer)
  private cursor: Position = { line: 0, col: 0 }
  /** On-screen column to aim for when moving up/down (null = use current). */
  private goalVisual: number | null = null
  private charWidth = 8
  private lineHeight = 20
  private _dirty = false

  constructor(container: HTMLElement, private readonly opts: EditorOptions = {}) {
    this.root = el('div', 'editor')
    this.gutter = el('pre', 'gutter')
    this.textArea = el('div', 'text-area')
    this.content = el('pre', 'content')
    this.cursorEl = el('div', 'cursor')
    this.input = el('textarea', 'input')
    this.input.spellcheck = false
    this.input.autocapitalize = 'off'
    this.input.setAttribute('autocomplete', 'off')
    this.input.setAttribute('aria-label', 'Code editor')

    this.textArea.append(this.content, this.cursorEl, this.input)
    container.replaceChildren(this.root)

    this.input.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.input.addEventListener('input', (e) => this.onInput(e as InputEvent))
    this.input.addEventListener('focus', () => this.root.classList.add('focused'))
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'))
    this.textArea.addEventListener('mousedown', (e) => this.onMouseDown(e))

    this.showPlaceholder('Open a folder and pick a file')
  }

  get dirty(): boolean {
    return this._dirty
  }

  open(text: string): void {
    this.buffer = new TextBuffer(text)
    this.history = new History(this.buffer)
    this.cursor = { line: 0, col: 0 }
    this.goalVisual = null
    this.root.className = 'editor'
    this.root.replaceChildren(this.gutter, this.textArea)
    this.measure()
    this.setDirty(false)
    this.render()
    this.root.scrollTo(0, 0)
    this.focus()
  }

  getText(): string {
    return this.buffer.getText()
  }

  markSaved(): void {
    this.history.markSaved()
    this.setDirty(false)
  }

  focus(): void {
    this.input.focus({ preventScroll: true })
  }

  showPlaceholder(message: string): void {
    this.root.className = 'editor empty'
    this.root.textContent = message
  }

  // ---------- input handling ----------

  private onKeyDown(e: KeyboardEvent): void {
    const b = this.buffer
    const pos = this.cursor
    const ctrl = e.ctrlKey || e.metaKey
    let next: Position | null = null
    let edited = false
    let vertical = false
    /** Run an editing command as one undoable step. */
    const edit = (kind: EditKind, fn: () => Position): Position => {
      edited = true
      return this.history.transact(kind, pos, fn)
    }

    // Undo: Ctrl+Z. Redo: Ctrl+Y or Ctrl+Shift+Z.
    const k = e.key.toLowerCase()
    if (ctrl && (k === 'z' || k === 'y')) {
      e.preventDefault()
      const target = k === 'y' || e.shiftKey ? this.history.redo() : this.history.undo()
      if (target) {
        this.cursor = this.buffer.clamp(target)
        this.goalVisual = null
        this.setDirty(this.history.isDirty())
        this.render(true)
      }
      return
    }

    switch (e.key) {
      case 'ArrowLeft': next = cmd.moveLeft(b, pos); break
      case 'ArrowRight': next = cmd.moveRight(b, pos); break
      case 'ArrowUp': next = this.vertical(-1); vertical = true; break
      case 'ArrowDown': next = this.vertical(1); vertical = true; break
      case 'PageUp': next = this.vertical(-this.pageLines()); vertical = true; break
      case 'PageDown': next = this.vertical(this.pageLines()); vertical = true; break
      case 'Home':
        next = ctrl ? { line: 0, col: 0 } : cmd.moveHome(b, pos)
        break
      case 'End':
        next = ctrl ? b.clamp({ line: Infinity, col: Infinity }) : cmd.moveEnd(b, pos)
        break
      case 'Backspace': next = edit('delete', () => cmd.backspace(b, pos, TAB_SIZE)); break
      case 'Delete': next = edit('delete', () => cmd.deleteForward(b, pos)); break
      case 'Enter': next = edit('newline', () => cmd.newline(b, pos, TAB_SIZE)); break
      case 'Tab':
        if (ctrl) return // leave Ctrl+Tab for future tab switching
        next = edit('other', () => cmd.insertTab(b, pos, TAB_SIZE))
        break
      default:
        return // normal characters arrive via the 'input' event
    }

    e.preventDefault()
    if (!vertical) this.goalVisual = null
    this.cursor = next
    if (edited) this.setDirty(this.history.isDirty())
    this.render(edited)
  }

  private onInput(e: InputEvent): void {
    const text = this.input.value
    this.input.value = ''
    if (!text) return
    const kind: EditKind = e.inputType === 'insertFromPaste' ? 'paste' : 'typing'
    const pos = this.cursor
    this.cursor = this.history.transact(kind, pos, () => this.buffer.insert(pos, text))
    this.goalVisual = null
    this.setDirty(this.history.isDirty())
    this.render(true)
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    e.preventDefault() // keep focus in our hidden textarea
    const rect = this.content.getBoundingClientRect()
    const line = Math.floor((e.clientY - rect.top - PAD_TOP) / this.lineHeight)
    const clampedLine = Math.min(Math.max(line, 0), this.buffer.lineCount - 1)
    const visual = Math.round((e.clientX - rect.left - PAD_LEFT) / this.charWidth)
    const col = cmd.colFromVisual(this.buffer.getLine(clampedLine), Math.max(visual, 0), TAB_SIZE)
    this.cursor = { line: clampedLine, col }
    this.goalVisual = null
    this.render(false)
    this.focus()
  }

  private vertical(delta: number): Position {
    if (this.goalVisual === null) {
      this.goalVisual = cmd.visualCol(this.buffer.getLine(this.cursor.line), this.cursor.col, TAB_SIZE)
    }
    return cmd.moveVertical(this.buffer, this.cursor, delta, this.goalVisual, TAB_SIZE)
  }

  private pageLines(): number {
    return Math.max(1, Math.floor(this.root.clientHeight / this.lineHeight) - 1)
  }

  // ---------- rendering ----------

  private setDirty(dirty: boolean): void {
    if (dirty === this._dirty) return
    this._dirty = dirty
    this.opts.onDirtyChange?.(dirty)
  }

  /** Measure the monospace font so we can map line/column ↔ pixels. */
  private measure(): void {
    const probe = el('span', '')
    probe.textContent = 'x'.repeat(100)
    this.content.replaceChildren(probe)
    this.charWidth = probe.getBoundingClientRect().width / 100 || 8
    this.lineHeight = parseFloat(getComputedStyle(this.content).lineHeight) || 20
  }

  private render(textChanged = true): void {
    if (textChanged) {
      const lines = this.buffer.getLines()
      // textContent (never innerHTML) so file contents can't be parsed as HTML.
      this.content.textContent = lines.join('\n')
      let numbers = ''
      for (let i = 1; i <= lines.length; i++) numbers += i === 1 ? '1' : '\n' + i
      this.gutter.textContent = numbers
    }
    this.placeCursor()
  }

  private placeCursor(): void {
    const { line, col } = this.cursor
    const x = PAD_LEFT + cmd.visualCol(this.buffer.getLine(line), col, TAB_SIZE) * this.charWidth
    const y = PAD_TOP + line * this.lineHeight
    for (const node of [this.cursorEl, this.input]) {
      node.style.transform = `translate(${x}px, ${y}px)`
    }
    // Restart the blink animation so the cursor is solid right after moving.
    this.cursorEl.style.animation = 'none'
    void this.cursorEl.offsetWidth
    this.cursorEl.style.animation = ''
    this.scrollIntoView(x, y)
  }

  private scrollIntoView(x: number, y: number): void {
    const view = this.root
    const margin = this.lineHeight
    if (y - margin < view.scrollTop) view.scrollTop = Math.max(0, y - margin)
    else if (y + this.lineHeight + margin > view.scrollTop + view.clientHeight) {
      view.scrollTop = y + this.lineHeight + margin - view.clientHeight
    }
    const gutterWidth = this.gutter.offsetWidth
    const visibleText = view.clientWidth - gutterWidth
    const margin2 = this.charWidth * 4
    if (x - margin2 < view.scrollLeft) view.scrollLeft = Math.max(0, x - margin2)
    else if (x + margin2 > view.scrollLeft + visibleText) {
      view.scrollLeft = x + margin2 - visibleText
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}
