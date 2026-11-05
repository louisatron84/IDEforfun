/**
 * Our hand-written editor.
 *
 * How it works:
 * - The text lives in a TextBuffer (the model). Commands in commands.ts and
 *   selection.ts change it; History records every change for undo/redo.
 * - Only the lines visible on screen are in the DOM ("virtual scrolling"): the
 *   content area is as tall as the whole file, and the ~40 visible lines are
 *   drawn as colored spans (from the Highlighter) and shifted into place.
 *   Selection highlights are absolutely positioned divs behind the text.
 * - The cursor is a div we position ourselves, using the monospace character width.
 * - Keystrokes go into an invisible <textarea> that follows the cursor. That gives
 *   us typing, paste and IME (e.g. accented chars) from the browser for free;
 *   we read what was typed, insert it into the buffer and clear the textarea.
 */
import type { Position } from './textBuffer'
import { comparePositions } from './textBuffer'
import * as cmd from './commands'
import * as sel from './selection'
import type { EditKind } from './history'
import { Doc } from './document'
import * as mc from './multiCursor'

const PAD_TOP = 4 // space above the first line
const PAD_LEFT = 12 // must match .editor .lines padding-left in styles.css
const PAD_RIGHT = 24
const GUTTER_PAD = 40 // gutter's left (room for breakpoint dots) + right padding around the numbers
/** Extra lines drawn above/below the visible area so fast scrolling doesn't flash. */
const OVERSCAN = 5

export interface EditorOptions {
  /** Called after every edit (and undo/redo) to the shown document. */
  onEdit?: (doc: Doc) => void
  /** Mouse moved over the text: the character under it (null if over empty space). */
  onMouseMove?: (pos: Position | null, e: MouseEvent) => void
  onMouseLeave?: () => void
  /** Called first for every key in the editor; return true to say "handled, don't do anything else". */
  onKeyDown?: (e: KeyboardEvent) => boolean
  /** Called after the user typed text (not pasted), e.g. to open autocomplete. */
  onType?: (text: string) => void
  /** Ctrl+click on the text (after the cursor was placed there), e.g. go to definition. */
  onCtrlClick?: (pos: Position) => void
  /** Click in the line-number gutter (0-based line), e.g. to toggle a breakpoint. */
  onGutterClick?: (line: number) => void
}

/** An underlined range, e.g. an error from the language server. */
export interface Squiggle {
  start: Position
  end: Position
  /** 1 error, 2 warning, 3 info, 4 hint (hints are not drawn) */
  severity: number
}

export class Editor {
  private readonly root: HTMLDivElement
  private readonly gutter: HTMLDivElement
  private readonly gutterLines: HTMLDivElement
  private readonly textArea: HTMLDivElement
  private readonly selectionLayer: HTMLDivElement
  private readonly content: HTMLDivElement
  private readonly linesEl: HTMLDivElement
  private readonly cursorEl: HTMLDivElement
  private readonly input: HTMLTextAreaElement

  /** The document being shown (an empty placeholder when no file is open). */
  private doc: Doc = new Doc('', '')
  private hasDoc = false
  /** On-screen column to aim for when moving up/down (null = use current). */
  private goalVisual: number | null = null
  private charWidth = 8
  private lineHeight = 20
  private _tabSize = 4

  // The document's state, accessed through short names to keep the code readable.
  private get buffer() { return this.doc.buffer }
  private get history() { return this.doc.history }
  private get highlighter() { return this.doc.highlighter }
  /** The cursor is the selection's head; `anchor` is where the selection started. */
  private get cursor() { return this.doc.cursor }
  private set cursor(p: Position) { this.doc.cursor = p }
  private get anchor() { return this.doc.anchor }
  private set anchor(p: Position) { this.doc.anchor = p }

  constructor(container: HTMLElement, private readonly opts: EditorOptions = {}) {
    this.root = el('div', 'editor')
    this.gutter = el('div', 'gutter')
    this.gutterLines = el('div', 'gutter-lines')
    this.gutter.append(this.gutterLines)
    this.textArea = el('div', 'text-area')
    this.selectionLayer = el('div', 'selection-layer')
    this.content = el('div', 'content')
    this.linesEl = el('div', 'lines')
    this.content.append(this.linesEl)
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
    this.textArea.addEventListener('mousemove', (e) => {
      if (this.hasDoc) this.opts.onMouseMove?.(this.hitTest(e.clientX, e.clientY), e)
    })
    this.textArea.addEventListener('mouseleave', () => this.opts.onMouseLeave?.())
    this.gutter.addEventListener('mousedown', (e) => {
      if (!this.hasDoc || e.button !== 0) return
      e.preventDefault() // keep focus in the editor
      const line = Math.floor((e.clientY - this.content.getBoundingClientRect().top - PAD_TOP) / this.lineHeight)
      if (line >= 0 && line < this.buffer.lineCount) this.opts.onGutterClick?.(line)
    })
    this.root.addEventListener('scroll', () => {
      this.renderLines()
      this.renderSelection()
    })

    this.showPlaceholder('Open a folder and pick a file')
  }

  /** Show a document, remembering the scroll position of the one being left. */
  show(doc: Doc): void {
    this.rememberScroll()
    this.doc = doc
    this.hasDoc = true
    this.goalVisual = null
    this.root.className = 'editor'
    this.root.replaceChildren(this.gutter, this.textArea)
    this.measure()
    this.updateSize()
    this.root.scrollTop = doc.scrollTop
    this.root.scrollLeft = doc.scrollLeft
    this.renderLines()
    this.renderSelection()
    this.positionCursor()
    this.focus()
  }

  get currentDoc(): Doc | null {
    return this.hasDoc ? this.doc : null
  }

  get tabSize(): number {
    return this._tabSize
  }

  /** Apply new font/tab settings: re-measure and redraw. */
  refreshLayout(tabSize: number): void {
    this._tabSize = tabSize
    if (!this.hasDoc) return
    this.measure()
    this.render()
  }

  /** Move the cursor to a line (1-based column optional), e.g. from a traceback link. */
  goTo(line: number, col = 0): void {
    this.clearExtras()
    const pos = this.buffer.clamp({ line, col })
    this.cursor = this.anchor = pos
    this.goalVisual = null
    this.render(false, 'center')
    this.focus()
  }

  /** The current selection (anchor = where it started, head = cursor). */
  getSelection(): sel.Selection {
    return this.selection
  }

  /** The selected text, or '' if nothing is selected. */
  getSelectedText(): string {
    return this.hasSelection() ? this.selectedText() : ''
  }

  /** Run an edit from outside the editor (e.g. Replace All) as one undo step. */
  runEdit(fn: (buffer: Doc['buffer']) => Position): void {
    if (!this.hasDoc) return
    this.clearExtras()
    const next = this.history.transact('other', this.cursor, () => fn(this.buffer))
    this.afterEdit(next)
  }

  /** Select a range (used by find). */
  select(anchor: Position, head: Position): void {
    this.clearExtras()
    this.anchor = anchor
    this.cursor = head
    this.goalVisual = null
    this.render(false, 'center')
  }

  focus(): void {
    this.input.focus({ preventScroll: true })
  }

  showPlaceholder(message: string): void {
    this.rememberScroll()
    this.hasDoc = false
    this.doc = new Doc('', '')
    this.root.className = 'editor empty'
    this.root.textContent = message
  }

  private rememberScroll(): void {
    if (!this.hasDoc) return
    this.doc.scrollTop = this.root.scrollTop
    this.doc.scrollLeft = this.root.scrollLeft
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

  // ---------- multi-cursor ----------

  /** True when there are extra cursors besides the main one. */
  private get multi(): boolean {
    return this.doc.extras.length > 0
  }

  /** How many cursors there are (1 normally). */
  get cursorCount(): number {
    return 1 + (this.hasDoc ? this.doc.extras.length : 0)
  }

  private allSelections(): mc.MultiSelection[] {
    return [{ anchor: this.anchor, head: this.cursor, primary: true }, ...this.doc.extras]
  }

  /** Replace all cursors; the one marked primary becomes the main cursor. */
  private setSelections(list: readonly mc.MultiSelection[]): void {
    const all = mc.normalize(list)
    const primary = all.find((s) => s.primary)!
    this.anchor = primary.anchor
    this.cursor = primary.head
    this.doc.extras = all.filter((s) => s !== primary).map(({ anchor, head }) => ({ anchor, head }))
  }

  /** Back to a single cursor (the main one). */
  private clearExtras(): void {
    if (this.hasDoc) this.doc.extras = []
  }

  /** Run an edit at every cursor as one undo step. */
  private editMulti(kind: EditKind, op: (s: sel.Selection, index: number) => sel.Selection): void {
    let result: mc.MultiSelection[] = []
    this.history.transact(kind, this.cursor, () => {
      result = mc.editAll(this.buffer, this.allSelections(), op)
      return result.find((s) => s.primary)!.head
    })
    if (!result.length) return
    this.setSelections(result)
    this.goalVisual = null
    this.render(true)
    this.opts.onEdit?.(this.doc)
  }

  /** Keys that create or remove extra cursors. Returns true if handled. */
  private multiCursorKeys(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const b = this.buffer
    // Escape: back to one cursor.
    if (e.key === 'Escape' && this.multi) {
      this.clearExtras()
      this.render(false)
      return true
    }
    // Ctrl+D: select the word, then add the next match of the selection as another cursor.
    if (ctrl && !e.shiftKey && !e.altKey && k === 'd') {
      if (!this.hasSelection()) {
        const [start, end] = sel.wordAt(b.getLine(this.cursor.line), this.cursor.col)
        if (start === end) return true
        this.anchor = { line: this.cursor.line, col: start }
        this.cursor = { line: this.cursor.line, col: end }
      } else {
        const all = this.allSelections()
        const found = mc.nextOccurrence(b, this.selectedText(), sel.selectionRange(this.selection).end, all)
        if (found) this.setSelections([...all.map((s) => ({ ...s, primary: false })), { ...found, primary: true }])
      }
      this.render(false, 'center')
      return true
    }
    // Ctrl+Shift+L: a cursor at every match of the selection (or the word under the cursor).
    if (ctrl && e.shiftKey && !e.altKey && k === 'l') {
      let text = this.selectedText()
      if (!text) {
        const [start, end] = sel.wordAt(b.getLine(this.cursor.line), this.cursor.col)
        text = b.getLine(this.cursor.line).slice(start, end)
      }
      const found = mc.allOccurrences(b, text)
      if (found.length) {
        const here = found.findIndex((s) => comparePositions(s.anchor, this.cursor) <= 0 && comparePositions(this.cursor, s.head) <= 0)
        this.setSelections(found.map((s, i) => ({ ...s, primary: i === (here === -1 ? 0 : here) })))
        this.render(false)
      }
      return true
    }
    // Ctrl+Alt+Up/Down: add a cursor on the line above/below.
    if (ctrl && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const all = mc.normalize(this.allSelections())
      const edge = e.key === 'ArrowUp' ? all[0] : all[all.length - 1]
      const delta = e.key === 'ArrowUp' ? -1 : 1
      const line = edge.head.line + delta
      if (line < 0 || line >= b.lineCount) return true
      const goal = cmd.visualCol(b.getLine(edge.head.line), edge.head.col, this._tabSize)
      const t = cmd.moveVertical(b, edge.head, delta, goal, this._tabSize)
      this.setSelections([...all.map((s) => ({ ...s, primary: false })), { anchor: t, head: t, primary: true }])
      this.render(false)
      return true
    }
    return false
  }

  /** Movement and editing keys when there are several cursors. Returns true if handled. */
  private multiKeyDown(e: KeyboardEvent): boolean {
    const b = this.buffer
    const ctrl = e.ctrlKey || e.metaKey
    const shift = e.shiftKey
    const tab = this._tabSize

    const move = (s: sel.Selection): Position | null => {
      const pos = s.head
      const has = !sel.isEmpty(s)
      const vertical = (delta: number) =>
        cmd.moveVertical(b, pos, delta, cmd.visualCol(b.getLine(pos.line), pos.col, tab), tab)
      switch (e.key) {
        case 'ArrowLeft':
          return !shift && !ctrl && has ? sel.selectionRange(s).start : ctrl ? sel.wordLeft(b, pos) : cmd.moveLeft(b, pos)
        case 'ArrowRight':
          return !shift && !ctrl && has ? sel.selectionRange(s).end : ctrl ? sel.wordRight(b, pos) : cmd.moveRight(b, pos)
        case 'ArrowUp': return vertical(-1)
        case 'ArrowDown': return vertical(1)
        case 'Home': return cmd.moveHome(b, pos)
        case 'End': return cmd.moveEnd(b, pos)
      }
      return null
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && !(ctrl && e.altKey)) {
      if (ctrl && (e.key === 'Home' || e.key === 'End')) {
        this.clearExtras() // Ctrl+Home/End: jump to the start/end with one cursor
        return false
      }
      this.setSelections(this.allSelections().map((s) => {
        const t = move(s) ?? s.head
        return { anchor: shift ? s.anchor : t, head: t, primary: (s as mc.MultiSelection).primary }
      }))
      this.goalVisual = null
      this.render(false)
      return true
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      this.clearExtras()
      return false
    }

    const replace = (s: sel.Selection): Position => (sel.isEmpty(s) ? s.head : sel.deleteSelection(b, s))
    const at = (p: Position): sel.Selection => ({ anchor: p, head: p })
    switch (e.key) {
      case 'Backspace':
        this.editMulti('delete', (s) => {
          if (!sel.isEmpty(s)) return at(sel.deleteSelection(b, s))
          if (ctrl) {
            const start = sel.wordLeft(b, s.head)
            b.delete(start, s.head)
            return at(start)
          }
          return at(cmd.backspace(b, s.head, tab))
        })
        return true
      case 'Delete':
        this.editMulti('delete', (s) => {
          if (!sel.isEmpty(s)) return at(sel.deleteSelection(b, s))
          if (ctrl) b.delete(s.head, sel.wordRight(b, s.head))
          else cmd.deleteForward(b, s.head)
          return at(s.head)
        })
        return true
      case 'Enter':
        this.editMulti('newline', (s) => at(cmd.newline(b, replace(s), tab)))
        return true
      case 'Tab': {
        if (ctrl) return false
        this.editMulti('other', (s) => {
          const [first, last] = sel.selectedLines(s)
          if (shift) return sel.dedentLines(b, s, tab)
          if (!sel.isEmpty(s) && first !== last) return sel.indentLines(b, s, tab)
          return at(cmd.insertTab(b, replace(s), tab))
        })
        return true
      }
    }
    return false
  }

  /** Copy/cut with several cursors: one piece per cursor, joined by newlines. */
  private copyOrCutMulti(cut: boolean): void {
    const b = this.buffer
    const all = mc.normalize(this.allSelections())
    const pieces = all.map((s) => (sel.isEmpty(s) ? b.getLine(s.head.line) : b.getRange(s.anchor, s.head)))
    writeClipboard(pieces.join('\n'), this.input)
    if (!cut) return
    this.editMulti('other', (s) => {
      if (!sel.isEmpty(s)) {
        const p = sel.deleteSelection(b, s)
        return { anchor: p, head: p }
      }
      const line = s.head.line
      const isLast = line === b.lineCount - 1
      if (isLast && line > 0) b.delete({ line: line - 1, col: b.getLine(line - 1).length }, { line, col: b.getLine(line).length })
      else if (isLast) b.delete({ line, col: 0 }, { line, col: b.getLine(line).length })
      else b.delete({ line, col: 0 }, { line: line + 1, col: 0 })
      const p = b.clamp({ line, col: 0 })
      return { anchor: p, head: p }
    })
  }

  // ---------- keyboard ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (this.opts.onKeyDown?.(e)) {
      e.preventDefault()
      return
    }
    const b = this.buffer
    const pos = this.cursor
    const ctrl = e.ctrlKey || e.metaKey
    const shift = e.shiftKey
    const k = e.key.toLowerCase()

    // --- multiple cursors ---
    if (this.multiCursorKeys(e) || (this.multi && !(ctrl && 'zyacx'.includes(k)) && this.multiKeyDown(e))) {
      e.preventDefault()
      return
    }

    // --- shortcuts with Ctrl ---
    if (ctrl && (k === 'z' || k === 'y')) {
      e.preventDefault()
      this.clearExtras()
      const target = k === 'y' || shift ? this.history.redo() : this.history.undo()
      if (target) this.afterEdit(this.buffer.clamp(target))
      return
    }
    if (ctrl && k === 'a') {
      e.preventDefault()
      this.clearExtras()
      this.anchor = { line: 0, col: 0 }
      this.cursor = b.clamp({ line: Infinity, col: Infinity })
      this.render(false)
      return
    }
    if (ctrl && (k === 'c' || k === 'x')) {
      e.preventDefault()
      if (this.multi) this.copyOrCutMulti(k === 'x')
      else this.copyOrCut(k === 'x')
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
        else edit = () => cmd.backspace(b, pos, this._tabSize)
        break
      case 'Delete':
        kind = 'delete'
        if (hadSelection) edit = replaceSelection
        else if (ctrl) edit = () => (b.delete(pos, sel.wordRight(b, pos)), pos)
        else edit = () => cmd.deleteForward(b, pos)
        break
      case 'Enter':
        kind = 'newline'
        edit = () => cmd.newline(b, replaceSelection(), this._tabSize)
        break
      case 'Tab': {
        if (ctrl) return // leave Ctrl+Tab for future tab switching
        e.preventDefault()
        const [first, last] = sel.selectedLines(s)
        if (shift || (hadSelection && first !== last)) {
          // Indent/dedent whole lines and keep the selection.
          let result: sel.Selection = s
          this.history.transact('other', pos, () => {
            result = shift ? sel.dedentLines(b, s, this._tabSize) : sel.indentLines(b, s, this._tabSize)
            return result.head
          })
          this.afterEdit(result.head, result.anchor)
          return
        }
        edit = () => cmd.insertTab(b, replaceSelection(), this._tabSize)
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
    if (this.multi) {
      // Pasting as many lines as there are cursors puts one line at each cursor.
      const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
      const perCursor = kind === 'paste' && lines.length === this.cursorCount
      this.editMulti(kind, (s, i) => {
        const at = sel.isEmpty(s) ? s.head : sel.deleteSelection(this.buffer, s)
        const p = this.buffer.insert(at, perCursor ? lines[i] : text)
        return { anchor: p, head: p }
      })
      return // no autocomplete with several cursors
    }
    const hadSelection = this.hasSelection()
    const s = this.selection
    // Typing over a selection is a normal 'typing' step, so the letters typed after it
    // merge in and one Ctrl+Z brings the original selection text back.
    const next = this.history.transact(kind, this.cursor, () => {
      const at = hadSelection ? sel.deleteSelection(this.buffer, s) : this.cursor
      return this.buffer.insert(at, text)
    })
    this.afterEdit(next)
    if (kind === 'typing') this.opts.onType?.(text)
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
    this.render(true)
    this.opts.onEdit?.(this.doc)
  }

  // ---------- mouse ----------

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    e.preventDefault() // keep focus in our hidden textarea
    const pos = this.positionFromMouse(e)

    // Alt+click: add another cursor (it becomes the main one).
    if (e.altKey && !e.shiftKey && e.detail === 1) {
      const all = this.allSelections().map((s) => ({ ...s, primary: false }))
      this.setSelections([...all, { anchor: pos, head: pos, primary: true }])
      this.goalVisual = null
      this.render(false)
      this.focus()
      return
    }
    this.clearExtras()

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

    if ((e.ctrlKey || e.metaKey) && e.detail === 1 && !e.shiftKey) {
      this.opts.onCtrlClick?.(pos)
      return
    }
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
    return { line: rawLine, col: cmd.colFromVisual(this.buffer.getLine(rawLine), Math.max(visual, 0), this._tabSize) }
  }

  private vertical(delta: number): Position {
    if (this.goalVisual === null) {
      this.goalVisual = cmd.visualCol(this.buffer.getLine(this.cursor.line), this.cursor.col, this._tabSize)
    }
    return cmd.moveVertical(this.buffer, this.cursor, delta, this.goalVisual, this._tabSize)
  }

  private pageLines(): number {
    return Math.max(1, Math.floor(this.root.clientHeight / this.lineHeight) - 1)
  }

  // ---------- rendering ----------

  /** Measure the monospace font so we can map line/column ↔ pixels. */
  private measure(): void {
    const probe = el('span', '')
    probe.textContent = 'x'.repeat(100)
    this.linesEl.replaceChildren(probe)
    this.charWidth = probe.getBoundingClientRect().width / 100 || 8
    this.lineHeight = parseFloat(getComputedStyle(this.content).lineHeight) || 20
  }

  /**
   * Redraw after a change. `scroll` decides how to bring the cursor into view:
   * 'nearest' scrolls as little as possible, 'center' puts it mid-screen
   * (used for jumps such as find results and error links).
   */
  private render(textChanged = true, scroll: 'nearest' | 'center' = 'nearest'): void {
    if (textChanged) this.updateSize()
    const { x, y } = this.positionCursor()
    this.scrollIntoView(x, y, scroll)
    this.renderLines()
    this.renderSelection()
  }

  /** Size the scrollable area to the whole file, even though only visible lines are drawn. */
  private updateSize(): void {
    const lines = this.buffer.getLines()
    let widest = 0
    for (const line of lines) {
      const cols = line.includes('\t') ? cmd.visualCol(line, line.length, this._tabSize) : line.length
      if (cols > widest) widest = cols
    }
    const height = `calc(${PAD_TOP + lines.length * this.lineHeight}px + 40vh)` // 40vh: let the last line scroll up
    this.content.style.height = height
    this.content.style.width = `${PAD_LEFT + widest * this.charWidth + PAD_RIGHT}px`
    this.gutter.style.height = height
    this.gutter.style.width = `${String(lines.length).length * this.charWidth + GUTTER_PAD}px`
  }

  /** Which lines are on screen, plus a few extra above and below. */
  private visibleRange(): [number, number] {
    const first = Math.floor((this.root.scrollTop - PAD_TOP) / this.lineHeight) - OVERSCAN
    const count = Math.ceil(this.root.clientHeight / this.lineHeight) + OVERSCAN * 2
    return [Math.max(0, first), Math.min(this.buffer.lineCount - 1, first + count)]
  }

  /** Draw just the visible lines, colored by the highlighter. */
  private renderLines(): void {
    const [first, last] = this.visibleRange()
    const lineEls: HTMLElement[] = []
    const numberEls: HTMLElement[] = []
    for (let i = first; i <= last; i++) {
      lineEls.push(this.renderLine(i))
      const num = el('div', this.breakpoints.has(i) ? (i === this.execLine ? 'bp exec' : 'bp') : i === this.execLine ? 'exec' : '')
      num.textContent = String(i + 1)
      numberEls.push(num)
    }
    const offset = `translateY(${PAD_TOP + first * this.lineHeight}px)`
    this.linesEl.style.transform = offset
    this.gutterLines.style.transform = offset
    this.linesEl.replaceChildren(...lineEls)
    this.gutterLines.replaceChildren(...numberEls)
  }

  private renderLine(index: number): HTMLElement {
    const text = this.buffer.getLine(index)
    const lineEl = el('div', 'line')
    let pos = 0
    // textContent / text nodes only (never innerHTML) so file contents can't be parsed as HTML.
    for (const tok of this.highlighter.tokensFor(index)) {
      if (tok.start > pos) lineEl.append(text.slice(pos, tok.start))
      const span = el('span', `tok-${tok.type}`)
      span.textContent = text.slice(tok.start, tok.end)
      lineEl.append(span)
      pos = tok.end
    }
    if (pos < text.length) lineEl.append(text.slice(pos))
    return lineEl
  }

  /** Debugger markers for the shown document: breakpoint lines, and the line it's paused on. */
  private breakpoints: ReadonlySet<number> = new Set()
  private execLine: number | null = null

  setLineMarkers(breakpoints: Iterable<number>, execLine: number | null): void {
    this.breakpoints = new Set(breakpoints)
    this.execLine = execLine
    if (!this.hasDoc) return
    this.renderLines()
    this.renderSelection()
  }

  /** Ranges to highlight besides the selection (find matches). Sorted by position. */
  private matches: { start: Position; end: Position }[] = []
  private squiggles: Squiggle[] = []

  setMatches(matches: { start: Position; end: Position }[]): void {
    this.matches = matches
    this.renderSelection()
  }

  /** Underline ranges (errors/warnings). Replaces the previous set. */
  setSquiggles(squiggles: Squiggle[]): void {
    this.squiggles = squiggles.filter((s) => s.severity <= 3)
    if (this.hasDoc) this.renderSelection()
  }

  /** The character under a screen point, or null if it's past the end of a line or below the text. */
  hitTest(clientX: number, clientY: number): Position | null {
    if (!this.hasDoc) return null
    const rect = this.content.getBoundingClientRect()
    const line = Math.floor((clientY - rect.top - PAD_TOP) / this.lineHeight)
    if (line < 0 || line >= this.buffer.lineCount) return null
    const text = this.buffer.getLine(line)
    const visual = Math.floor((clientX - rect.left - PAD_LEFT) / this.charWidth)
    if (visual < 0 || visual >= cmd.visualCol(text, text.length, this._tabSize)) return null
    // colFromVisual rounds to the nearest boundary; we want the character the point is inside.
    let col = cmd.colFromVisual(text, visual, this._tabSize)
    if (cmd.visualCol(text, col, this._tabSize) > visual) col--
    return { line, col: Math.max(0, col) }
  }

  /** Screen coordinates of a position (for popups such as autocomplete). */
  coordsAt(pos: Position): { left: number; top: number; bottom: number } {
    const rect = this.content.getBoundingClientRect()
    const x = PAD_LEFT + cmd.visualCol(this.buffer.getLine(pos.line), pos.col, this._tabSize) * this.charWidth
    const y = PAD_TOP + pos.line * this.lineHeight
    return { left: rect.left + x, top: rect.top + y, bottom: rect.top + y + this.lineHeight }
  }

  /** The cursor's position in the current document. */
  getCursor(): Position {
    return this.cursor
  }

  /**
   * Draw highlight boxes for find matches and the selection, only for lines
   * currently on screen.
   */
  private renderSelection(): void {
    const firstVisible = Math.floor((this.root.scrollTop - PAD_TOP) / this.lineHeight) - 1
    const lastVisible = firstVisible + Math.ceil(this.root.clientHeight / this.lineHeight) + 2
    const boxes: HTMLElement[] = []

    if (this.execLine !== null && this.execLine >= firstVisible && this.execLine <= lastVisible) {
      const box = el('div', 'exec-line')
      box.style.transform = `translateY(${PAD_TOP + this.execLine * this.lineHeight}px)`
      boxes.push(box)
    }
    for (const m of this.matches) {
      if (m.end.line < firstVisible) continue
      if (m.start.line > lastVisible) break
      this.addBoxes(boxes, m.start, m.end, 'match', firstVisible, lastVisible)
    }
    for (const s of this.squiggles) {
      if (s.end.line < firstVisible || s.start.line > lastVisible) continue
      this.addBoxes(boxes, s.start, s.end, `squiggle sev-${s.severity}`, firstVisible, lastVisible, true)
    }
    if (this.hasSelection()) {
      const { start, end } = sel.selectionRange(this.selection)
      this.addBoxes(boxes, start, end, 'sel', firstVisible, lastVisible)
    }
    // Extra cursors: their selections, plus a drawn cursor each (the main cursor is drawn separately).
    for (const s of this.doc.extras) {
      const { start, end } = sel.selectionRange(s)
      if (end.line < firstVisible || start.line > lastVisible) continue
      if (!sel.isEmpty(s)) this.addBoxes(boxes, start, end, 'sel', firstVisible, lastVisible)
      const x = PAD_LEFT + cmd.visualCol(this.buffer.getLine(s.head.line), s.head.col, this._tabSize) * this.charWidth
      const c = el('div', 'cursor extra-cursor')
      c.style.transform = `translate(${x}px, ${PAD_TOP + s.head.line * this.lineHeight}px)`
      boxes.push(c)
    }
    this.selectionLayer.replaceChildren(...boxes)
  }

  private addBoxes(
    boxes: HTMLElement[], start: Position, end: Position, className: string,
    firstVisible: number, lastVisible: number, atLeastOneChar = false
  ): void {
    const from = Math.max(start.line, firstVisible)
    const to = Math.min(end.line, lastVisible)
    for (let line = from; line <= to; line++) {
      const text = this.buffer.getLine(line)
      const x1 = line === start.line ? cmd.visualCol(text, start.col, this._tabSize) : 0
      // Lines that continue past the range end get one extra cell to show the line break.
      const x2 = line === end.line
        ? cmd.visualCol(text, end.col, this._tabSize)
        : cmd.visualCol(text, text.length, this._tabSize) + 1
      // Zero-width ranges (e.g. "expected expression" at a line end) still get one cell.
      const width = atLeastOneChar ? Math.max(x2 - x1, 1) : x2 - x1
      if (width <= 0) continue
      const box = el('div', className)
      box.style.transform = `translate(${PAD_LEFT + x1 * this.charWidth}px, ${PAD_TOP + line * this.lineHeight}px)`
      box.style.width = `${width * this.charWidth}px`
      boxes.push(box)
    }
  }

  /** Put the cursor (and hidden textarea) at the cursor position; returns its pixel position. */
  private positionCursor(): { x: number; y: number } {
    const { line, col } = this.cursor
    const x = PAD_LEFT + cmd.visualCol(this.buffer.getLine(line), col, this._tabSize) * this.charWidth
    const y = PAD_TOP + line * this.lineHeight
    for (const node of [this.cursorEl, this.input]) {
      node.style.transform = `translate(${x}px, ${y}px)`
    }
    // Restart the blink animation so the cursor is solid right after moving.
    this.cursorEl.style.animation = 'none'
    void this.cursorEl.offsetWidth
    this.cursorEl.style.animation = ''
    return { x, y }
  }

  private scrollIntoView(x: number, y: number, mode: 'nearest' | 'center'): void {
    const view = this.root
    const margin = this.lineHeight
    const offscreen = y < view.scrollTop || y + this.lineHeight > view.scrollTop + view.clientHeight
    if (mode === 'center' && offscreen) {
      view.scrollTop = Math.max(0, y - view.clientHeight / 2)
    } else if (y - margin < view.scrollTop) view.scrollTop = Math.max(0, y - margin)
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
