/**
 * Our hand-written editor.
 *
 * How it works:
 * - The text lives in a TextBuffer (the model). Commands in commands.ts and
 *   selection.ts change it; History records every change for undo/redo.
 * - It's drawn as a line-number gutter plus one <pre> holding all the text.
 *   Selection highlights are absolutely positioned divs behind the text.
 * - The cursor is a div we position ourselves, using the monospace character width.
 * - Keystrokes go into an invisible <textarea> that follows the cursor. That gives
 *   us typing, paste and IME (e.g. accented chars) from the browser for free;
 *   we read what was typed, insert it into the buffer and clear the textarea.
 *
 * Re-rendering the whole <pre> on each edit is fine for normal files. Rendering
 * only the visible lines is on the checklist for big files.
 */
import type { Position } from './textBuffer'
import { TextBuffer, comparePositions } from './textBuffer'
import * as cmd from './commands'
import * as sel from './selection'
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
  private readonly selectionLayer: HTMLDivElement
  private readonly content: HTMLPreElement
  private readonly cursorEl: HTMLDivElement
  private readonly input: HTMLTextAreaElement

  private buffer = new TextBuffer('')
  private history = new History(this.buffer)
  /** The cursor is the selection's head; `anchor` is where the selection started. */
  private cursor: Position = { line: 0, col: 0 }
  private anchor: Position = { line: 0, col: 0 }
  /** On-screen column to aim for when moving up/down (null = use current). */
  private goalVisual: number | null = null
  private charWidth = 8
  private lineHeight = 20
  private _dirty = false

  constructor(container: HTMLElement, private readonly opts: EditorOptions = {}) {
    this.root = el('div', 'editor')
    this.gutter = el('pre', 'gutter')
    this.textArea = el('div', 'text-area')
    this.selectionLayer = el('div', 'selection-layer')
    this.content = el('pre', 'content')
    this.cursorEl = el('div', 'cursor')
    this.input = el('textarea', 'input')
    this.input.spellcheck = false
    this.input.autocapitalize = 'off'
    this.input.setAttribute('autocomplete', 'off')
    this.input.setAttribute('aria-label', 'Code editor')

    this.textArea.append(this.selectionLayer, this.content, this.cursorEl, this.input)
    container.replaceChildren(this.root)

    this.input.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.input.addEventListener('input', (e) => this.onInput(e as InputEvent))
    this.input.addEventListener('focus', () => this.root.classList.add('focused'))
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'))
    this.textArea.addEventListener('mousedown', (e) => this.onMouseDown(e))
    this.root.addEventListener('scroll', () => this.renderSelection())

    this.showPlaceholder('Open a folder and pick a file')
  }

  get dirty(): boolean {
    return this._dirty
  }

  open(text: string): void {
    this.buffer = new TextBuffer(text)
    this.history = new History(this.buffer)
    this.cursor = this.anchor = { line: 0, col: 0 }
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

  // ---------- selection helpers ----------

  private get selection(): sel.Selection {
    return { anchor: this.anchor, head: this.cursor }
  }

  private hasSelection(): boolean {
    return !sel.isEmpty(this.selection)
  }

  private selectedText(): string {
    return this.buffer.getRange(this.anchor, this.cursor)
  }

  // ---------- keyboard ----------

  private onKeyDown(e: KeyboardEvent): void {
    const b = this.buffer
    const pos = this.cursor
    const ctrl = e.ctrlKey || e.metaKey
    const shift = e.shiftKey
    const k = e.key.toLowerCase()

    // --- shortcuts with Ctrl ---
    if (ctrl && (k === 'z' || k === 'y')) {
      e.preventDefault()
      const target = k === 'y' || shift ? this.history.redo() : this.history.undo()
      if (target) this.afterEdit(this.buffer.clamp(target))
      return
    }
    if (ctrl && k === 'a') {
      e.preventDefault()
      this.anchor = { line: 0, col: 0 }
      this.cursor = b.clamp({ line: Infinity, col: Infinity })
      this.render(false)
      return
    }
    if (ctrl && (k === 'c' || k === 'x')) {
      e.preventDefault()
      this.copyOrCut(k === 'x')
      return
    }

    // --- movement: Shift extends the selection, otherwise it collapses ---
    let target: Position | null = null
    let vertical = false
    switch (e.key) {
      case 'ArrowLeft':
        if (!shift && !ctrl && this.hasSelection()) target = sel.selectionRange(this.selection).start
        else target = ctrl ? sel.wordLeft(b, pos) : cmd.moveLeft(b, pos)
        break
      case 'ArrowRight':
        if (!shift && !ctrl && this.hasSelection()) target = sel.selectionRange(this.selection).end
        else target = ctrl ? sel.wordRight(b, pos) : cmd.moveRight(b, pos)
        break
      case 'ArrowUp': target = this.vertical(-1); vertical = true; break
      case 'ArrowDown': target = this.vertical(1); vertical = true; break
      case 'PageUp': target = this.vertical(-this.pageLines()); vertical = true; break
      case 'PageDown': target = this.vertical(this.pageLines()); vertical = true; break
      case 'Home': target = ctrl ? { line: 0, col: 0 } : cmd.moveHome(b, pos); break
      case 'End': target = ctrl ? b.clamp({ line: Infinity, col: Infinity }) : cmd.moveEnd(b, pos); break
    }
    if (target) {
      e.preventDefault()
      if (!vertical) this.goalVisual = null
      this.cursor = target
      if (!shift) this.anchor = target
      this.render(false)
      return
    }

    // --- editing ---
    const hadSelection = this.hasSelection()
    const s = this.selection
    const replaceSelection = (): Position => (hadSelection ? sel.deleteSelection(b, s) : pos)
    let edit: (() => Position) | null = null
    let kind: EditKind = 'other'

    switch (e.key) {
      case 'Backspace':
        kind = 'delete'
        if (hadSelection) edit = replaceSelection
        else if (ctrl) {
          edit = () => {
            const wordStart = sel.wordLeft(b, pos)
            b.delete(wordStart, pos)
            return wordStart
          }
        }
        else edit = () => cmd.backspace(b, pos, TAB_SIZE)
        break
      case 'Delete':
        kind = 'delete'
        if (hadSelection) edit = replaceSelection
        else if (ctrl) edit = () => (b.delete(pos, sel.wordRight(b, pos)), pos)
        else edit = () => cmd.deleteForward(b, pos)
        break
      case 'Enter':
        kind = 'newline'
        edit = () => cmd.newline(b, replaceSelection(), TAB_SIZE)
        break
      case 'Tab': {
        if (ctrl) return // leave Ctrl+Tab for future tab switching
        e.preventDefault()
        const [first, last] = sel.selectedLines(s)
        if (shift || (hadSelection && first !== last)) {
          // Indent/dedent whole lines and keep the selection.
          let result: sel.Selection = s
          this.history.transact('other', pos, () => {
            result = shift ? sel.dedentLines(b, s, TAB_SIZE) : sel.indentLines(b, s, TAB_SIZE)
            return result.head
          })
          this.afterEdit(result.head, result.anchor)
          return
        }
        edit = () => cmd.insertTab(b, replaceSelection(), TAB_SIZE)
        break
      }
      default:
        return // normal characters arrive via the 'input' event
    }

    e.preventDefault()
    this.afterEdit(this.history.transact(kind, pos, edit))
  }

  private onInput(e: InputEvent): void {
    const text = this.input.value
    this.input.value = ''
    if (!text) return
    const kind: EditKind = e.inputType === 'insertFromPaste' ? 'paste' : 'typing'
    const hadSelection = this.hasSelection()
    const s = this.selection
    // Typing over a selection is a normal 'typing' step, so the letters typed after it
    // merge in and one Ctrl+Z brings the original selection text back.
    const next = this.history.transact(kind, this.cursor, () => {
      const at = hadSelection ? sel.deleteSelection(this.buffer, s) : this.cursor
      return this.buffer.insert(at, text)
    })
    this.afterEdit(next)
  }

  /** Ctrl+C / Ctrl+X. With nothing selected, copies/cuts the whole line (VS Code style). */
  private copyOrCut(cut: boolean): void {
    const b = this.buffer
    const pos = this.cursor
    let text: string
    let start: Position
    let end: Position
    if (this.hasSelection()) {
      text = this.selectedText()
      ;({ start, end } = sel.selectionRange(this.selection))
    } else {
      text = b.getLine(pos.line) + '\n'
      const isLast = pos.line === b.lineCount - 1
      start = isLast && pos.line > 0
        ? { line: pos.line - 1, col: b.getLine(pos.line - 1).length }
        : { line: pos.line, col: 0 }
      end = isLast ? { line: pos.line, col: b.getLine(pos.line).length } : { line: pos.line + 1, col: 0 }
    }
    writeClipboard(text, this.input)
    if (!cut) return
    const wholeLine = !this.hasSelection()
    const next = this.history.transact('other', pos, () => {
      b.delete(start, end)
      // After cutting a whole line, the cursor goes to the start of the line that moved up.
      return wholeLine ? b.clamp({ line: pos.line, col: 0 }) : start
    })
    this.afterEdit(next)
  }

  /** After any edit: collapse the selection, update dirty state, redraw. */
  private afterEdit(cursor: Position, anchor: Position = cursor): void {
    this.cursor = cursor
    this.anchor = anchor
    this.goalVisual = null
    this.setDirty(this.history.isDirty())
    this.render(true)
  }

  // ---------- mouse ----------

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    e.preventDefault() // keep focus in our hidden textarea
    const pos = this.positionFromMouse(e)

    if (e.detail === 2) {
      const [start, end] = sel.wordAt(this.buffer.getLine(pos.line), pos.col)
      this.anchor = { line: pos.line, col: start }
      this.cursor = { line: pos.line, col: end }
    } else if (e.detail >= 3) {
      this.anchor = { line: pos.line, col: 0 }
      this.cursor = pos.line < this.buffer.lineCount - 1
        ? { line: pos.line + 1, col: 0 }
        : { line: pos.line, col: this.buffer.getLine(pos.line).length }
    } else {
      this.cursor = pos
      if (!e.shiftKey) this.anchor = pos
    }
    this.goalVisual = null
    this.render(false)
    this.focus()

    if (e.detail !== 1) return
    // Drag to select: track the mouse even outside the editor until the button is released.
    const onMove = (ev: MouseEvent) => {
      const next = this.positionFromMouse(ev)
      if (comparePositions(next, this.cursor) === 0) return
      this.cursor = next
      this.render(false)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  private positionFromMouse(e: MouseEvent): Position {
    const rect = this.content.getBoundingClientRect()
    const rawLine = Math.floor((e.clientY - rect.top - PAD_TOP) / this.lineHeight)
    if (rawLine < 0) return { line: 0, col: 0 }
    if (rawLine >= this.buffer.lineCount) return this.buffer.clamp({ line: Infinity, col: Infinity })
    const visual = Math.round((e.clientX - rect.left - PAD_LEFT) / this.charWidth)
    return { line: rawLine, col: cmd.colFromVisual(this.buffer.getLine(rawLine), Math.max(visual, 0), TAB_SIZE) }
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
    this.renderSelection()
  }

  /** Draw highlight boxes for the selected text, only for lines currently on screen. */
  private renderSelection(): void {
    if (!this.hasSelection()) {
      if (this.selectionLayer.firstChild) this.selectionLayer.replaceChildren()
      return
    }
    const { start, end } = sel.selectionRange(this.selection)
    const firstVisible = Math.floor((this.root.scrollTop - PAD_TOP) / this.lineHeight) - 1
    const lastVisible = firstVisible + Math.ceil(this.root.clientHeight / this.lineHeight) + 2
    const from = Math.max(start.line, firstVisible)
    const to = Math.min(end.line, lastVisible)

    const boxes: HTMLElement[] = []
    for (let line = from; line <= to; line++) {
      const text = this.buffer.getLine(line)
      const x1 = line === start.line ? cmd.visualCol(text, start.col, TAB_SIZE) : 0
      // Lines that continue past the selection end get one extra cell to show the line break.
      const x2 = line === end.line
        ? cmd.visualCol(text, end.col, TAB_SIZE)
        : cmd.visualCol(text, text.length, TAB_SIZE) + 1
      if (x2 <= x1) continue
      const box = el('div', 'sel')
      box.style.transform = `translate(${PAD_LEFT + x1 * this.charWidth}px, ${PAD_TOP + line * this.lineHeight}px)`
      box.style.width = `${(x2 - x1) * this.charWidth}px`
      boxes.push(box)
    }
    this.selectionLayer.replaceChildren(...boxes)
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

/** Copy text to the clipboard; falls back to the classic textarea + execCommand trick. */
function writeClipboard(text: string, scratch: HTMLTextAreaElement): void {
  const fallback = () => {
    scratch.value = text
    scratch.select()
    document.execCommand('copy')
    scratch.value = ''
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback)
  else fallback()
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}
