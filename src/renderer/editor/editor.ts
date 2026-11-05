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
import * as pairs from './pairs'
import { FoldMap, enclosingBlock, foldEnd, isFoldable } from './folding'
import { MINIMAP_WIDTH, Minimap } from './minimap'

const PAD_TOP = 4 // space above the first line
const PAD_LEFT = 12 // must match .editor .lines padding-left in styles.css
const PAD_RIGHT = 24
const GUTTER_PAD = 52 // gutter's left (breakpoint dots) + right (fold arrows) padding around the numbers
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
  /** The editor got keyboard focus (with a split view: this side became active). */
  onFocus?: () => void
  /** The cursor or selection moved, or the text changed (e.g. to update the status bar). */
  onCursor?: () => void
}

/**
 * Where this editor is in one document: cursor(s) and scroll position.
 * Kept per editor, so the same file open in both halves of a split view
 * has its own cursor on each side.
 */
interface ViewState {
  cursor: Position
  anchor: Position
  /** Extra cursors/selections besides the main one (multi-cursor editing). Usually empty. */
  extras: sel.Selection[]
  scrollTop: number
  scrollLeft: number
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
  private views = new WeakMap<Doc, ViewState>()
  private view: ViewState = this.viewFor(this.doc)
  /** A redraw requested because the shown file changed elsewhere (e.g. the other side of a split). */
  private passiveFrame = 0
  /** Counts full redraws, so a requested background redraw can be skipped if one already happened. */
  private renders = 0
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
  private get cursor() { return this.view.cursor }
  private set cursor(p: Position) { this.view.cursor = p }
  private get anchor() { return this.view.anchor }
  private set anchor(p: Position) { this.view.anchor = p }

  /** This editor's cursor/scroll state for a doc (created on first use). */
  private viewFor(doc: Doc): ViewState {
    let v = this.views.get(doc)
    if (v) return v
    const view: ViewState = { cursor: { line: 0, col: 0 }, anchor: { line: 0, col: 0 }, extras: [], scrollTop: 0, scrollLeft: 0 }
    v = view
    this.views.set(doc, v)
    doc.buffer.subscribe((change) => {
      // Edits made elsewhere (the other side of a split, or code) shift this view's cursors along.
      view.cursor = mc.mapPosition(view.cursor, change)
      view.anchor = mc.mapPosition(view.anchor, change)
      view.extras = view.extras.map((s) => ({ anchor: mc.mapPosition(s.anchor, change), head: mc.mapPosition(s.head, change) }))
      if (this.hasDoc && this.doc === doc) this.schedulePassiveRender()
    })
    return v
  }

  /** Redraw on the next frame without scrolling (the change may have come from elsewhere). */
  private schedulePassiveRender(): void {
    if (this.passiveFrame) return
    const before = this.renders
    this.passiveFrame = requestAnimationFrame(() => {
      this.passiveFrame = 0
      // Our own edits redraw straight away; only changes made elsewhere need this.
      if (this.hasDoc && this.renders === before) this.render(true, 'none')
    })
  }

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
    this.minimap = new Minimap({
      rowCount: () => this.foldMap.visibleCount(this.buffer.lineCount),
      lineAtRow: (row) => this.foldMap.bufferLine(row),
      getLine: (line) => this.buffer.getLine(line),
      tokens: (line) => this.highlighter.tokensIfCached(line),
      warmUp: (ms, upTo) => this.highlighter.warmUp(ms, upTo),
      scroll: () => ({ top: Math.max(0, this.root.scrollTop - PAD_TOP), height: this.root.clientHeight, rowHeight: this.lineHeight }),
      scrollToRow: (row) => {
        this.root.scrollTop = PAD_TOP + row * this.lineHeight - this.root.clientHeight / 2
      }
    })
    this.minimap.canvas.hidden = true
    container.classList.add('editor-host')
    container.replaceChildren(this.root, this.minimap.canvas)

    this.input.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.input.addEventListener('input', (e) => this.onInput(e as InputEvent))
    this.input.addEventListener('focus', () => {
      this.root.classList.add('focused')
      this.opts.onFocus?.()
    })
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'))
    this.textArea.addEventListener('mousedown', (e) => this.onMouseDown(e))
    this.textArea.addEventListener('mousemove', (e) => {
      if (this.hasDoc) this.opts.onMouseMove?.(this.hitTest(e.clientX, e.clientY), e)
    })
    this.textArea.addEventListener('mouseleave', () => this.opts.onMouseLeave?.())
    this.gutter.addEventListener('mousedown', (e) => {
      if (!this.hasDoc || e.button !== 0) return
      e.preventDefault() // keep focus in the editor
      const line = this.lineAtY(e.clientY - this.content.getBoundingClientRect().top)
      if (line < 0 || line >= this.buffer.lineCount) return
      if ((e.target as HTMLElement).closest('.fold-toggle')) this.toggleFold(line)
      else this.opts.onGutterClick?.(line)
    })
    this.root.addEventListener('scroll', () => {
      this.renderLines()
      this.renderSelection()
      this.minimap.schedule()
    })
    // Keep the minimap left of the scrollbar, and redraw it when the editor is resized.
    new ResizeObserver(() => {
      this.minimap.canvas.style.right = `${this.root.offsetWidth - this.root.clientWidth}px`
      this.minimap.schedule()
    }).observe(this.root)

    this.showPlaceholder('Open a folder to start: Ctrl+O, File → Open Folder, or drop a folder here.')
  }

  /** Show a document, remembering the scroll position of the one being left. */
  show(doc: Doc, focus = true): void {
    this.rememberScroll()
    this.doc = doc
    this.view = this.viewFor(doc)
    this.hasDoc = true
    this.goalVisual = null
    this.root.className = 'editor'
    this.minimap.canvas.hidden = !this.minimapOn
    this.root.replaceChildren(this.gutter, this.textArea)
    this.measure()
    this.rebuildFolds()
    this.updateSize()
    this.root.scrollTop = this.view.scrollTop
    this.root.scrollLeft = this.view.scrollLeft
    this.renderLines()
    this.renderSelection()
    this.positionCursor()
    if (focus) this.focus()
  }

  /** Where this editor's cursor and scroll are in `doc` (for remembering the layout). */
  viewInfo(doc: Doc): { line: number; col: number; scrollTop: number } | null {
    if (this.hasDoc && this.doc === doc) this.rememberScroll()
    const v = this.views.get(doc)
    return v ? { line: v.cursor.line, col: v.cursor.col, scrollTop: Math.round(v.scrollTop) } : null
  }

  /** Put the cursor and scroll back where they were in an earlier session. */
  restoreView(doc: Doc, info: { line: number; col: number; scrollTop: number }): void {
    const v = this.viewFor(doc)
    const pos = doc.buffer.clamp({ line: info.line, col: info.col })
    v.cursor = pos
    v.anchor = pos
    v.extras = []
    v.scrollTop = info.scrollTop
    if (this.hasDoc && this.doc === doc) {
      this.root.scrollTop = info.scrollTop
      this.render(false, 'none')
    }
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
    this.minimap.canvas.hidden = true
    this.hasDoc = false
    this.doc = new Doc('', '')
    this.view = this.viewFor(this.doc)
    this.root.className = 'editor empty'
    this.root.textContent = message
  }

  private rememberScroll(): void {
    if (!this.hasDoc) return
    this.view.scrollTop = this.root.scrollTop
    this.view.scrollLeft = this.root.scrollLeft
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

  // ---------- actions (also used by the Edit menu) ----------

  /** True when the editor has keyboard focus. */
  get hasFocus(): boolean {
    return document.activeElement === this.input
  }

  undo(): void {
    if (!this.hasDoc) return
    this.clearExtras()
    const target = this.history.undo()
    if (target) this.afterEdit(this.buffer.clamp(target))
  }

  redo(): void {
    if (!this.hasDoc) return
    this.clearExtras()
    const target = this.history.redo()
    if (target) this.afterEdit(this.buffer.clamp(target))
  }

  selectAll(): void {
    if (!this.hasDoc) return
    this.clearExtras()
    this.anchor = { line: 0, col: 0 }
    this.cursor = this.buffer.clamp({ line: Infinity, col: Infinity })
    this.render(false)
  }

  copy(): void {
    if (!this.hasDoc) return
    if (this.multi) this.copyOrCutMulti(false)
    else this.copyOrCut(false)
  }

  cut(): void {
    if (!this.hasDoc) return
    if (this.multi) this.copyOrCutMulti(true)
    else this.copyOrCut(true)
  }

  /** Ctrl+/: comment or uncomment the selected lines (at every cursor). */
  toggleComment(): void {
    if (!this.hasDoc) return
    const b = this.buffer
    // Several cursors on one line must toggle it once, not once per cursor.
    const done = new Set<number>()
    this.editMulti('other', (s) => {
      const [first, last] = sel.selectedLines(s)
      let fresh = false
      for (let l = first; l <= last; l++) if (!done.has(l)) fresh = true
      if (!fresh) return s
      for (let l = first; l <= last; l++) done.add(l)
      return pairs.toggleComment(b, s)
    })
  }

  // ---------- brackets ----------

  /** Auto-close brackets and quotes while typing. */
  autoClose = true
  private bracketMatch: { bracket: Position; match: Position } | null = null

  /** The bracket next to the cursor and its partner (ignoring brackets in strings and comments). */
  private findBracketMatch(): { bracket: Position; match: Position } | null {
    if (!this.hasDoc) return null
    const cache = new Map<number, ReturnType<Doc['highlighter']['tokensFor']>>()
    const isCode = (line: number, col: number) => {
      let tokens = cache.get(line)
      if (!tokens) cache.set(line, (tokens = this.highlighter.tokensFor(line)))
      const t = tokens.find((tok) => tok.start <= col && col < tok.end)
      return !t || (t.type !== 'string' && t.type !== 'comment')
    }
    return pairs.findMatchingBracket(this.buffer, this.cursor, isCode, 1000)
  }

  // ---------- multi-cursor ----------

  /** True when there are extra cursors besides the main one. */
  private get multi(): boolean {
    return this.view.extras.length > 0
  }

  /** How many cursors there are (1 normally). */
  get cursorCount(): number {
    return 1 + (this.hasDoc ? this.view.extras.length : 0)
  }

  private allSelections(): mc.MultiSelection[] {
    return [{ anchor: this.anchor, head: this.cursor, primary: true }, ...this.view.extras]
  }

  /** Replace all cursors; the one marked primary becomes the main cursor. */
  private setSelections(list: readonly mc.MultiSelection[]): void {
    const all = mc.normalize(list)
    const primary = all.find((s) => s.primary)!
    this.anchor = primary.anchor
    this.cursor = primary.head
    this.view.extras = all.filter((s) => s !== primary).map(({ anchor, head }) => ({ anchor, head }))
  }

  /** Back to a single cursor (the main one). */
  private clearExtras(): void {
    if (this.hasDoc) this.view.extras = []
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
          return at((this.autoClose && pairs.backspacePair(b, s.head)) || cmd.backspace(b, s.head, tab))
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
        this.editMulti('newline', (s) => at((sel.isEmpty(s) && pairs.newlineBetweenBrackets(b, s.head, tab)) || cmd.newline(b, replace(s), tab)))
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

    // --- comments and brackets ---
    if (ctrl && !e.altKey && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault()
      this.toggleComment()
      return
    }
    if (ctrl && shift && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault()
      if (e.code === 'BracketLeft') this.fold()
      else this.unfold()
      return
    }
    if (ctrl && shift && e.code === 'Backslash') {
      e.preventDefault()
      const m = this.findBracketMatch()
      if (m) {
        this.clearExtras()
        this.cursor = this.anchor = m.match
        this.render(false)
      }
      return
    }

    // --- shortcuts with Ctrl ---
    if (ctrl && (k === 'z' || k === 'y')) {
      e.preventDefault()
      if (k === 'y' || shift) this.redo()
      else this.undo()
      return
    }
    if (ctrl && k === 'a') {
      e.preventDefault()
      this.selectAll()
      return
    }
    if (ctrl && (k === 'c' || k === 'x')) {
      e.preventDefault()
      if (k === 'x') this.cut()
      else this.copy()
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
        else edit = () => (this.autoClose && pairs.backspacePair(b, pos)) || cmd.backspace(b, pos, this._tabSize)
        break
      case 'Delete':
        kind = 'delete'
        if (hadSelection) edit = replaceSelection
        else if (ctrl) edit = () => (b.delete(pos, sel.wordRight(b, pos)), pos)
        else edit = () => cmd.deleteForward(b, pos)
        break
      case 'Enter':
        kind = 'newline'
        edit = () => (!hadSelection && pairs.newlineBetweenBrackets(b, pos, this._tabSize)) || cmd.newline(b, replaceSelection(), this._tabSize)
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
        const paired = kind === 'typing' && text.length === 1 && this.autoClose ? pairs.typeChar(this.buffer, s, text) : null
        if (paired) return paired
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
    let anchor: Position | null = null
    const next = this.history.transact(kind, this.cursor, () => {
      // Brackets and quotes: auto-close, type over closers, wrap a selection.
      const paired = kind === 'typing' && text.length === 1 && this.autoClose ? pairs.typeChar(this.buffer, s, text) : null
      if (paired) {
        anchor = paired.anchor
        return paired.head
      }
      const at = hadSelection ? sel.deleteSelection(this.buffer, s) : this.cursor
      return this.buffer.insert(at, text)
    })
    this.afterEdit(next, anchor ?? next)
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
    const placeholder = (e.target as HTMLElement).closest?.('.fold-placeholder') as HTMLElement | null
    if (placeholder) {
      this.unfold(Number(placeholder.dataset.line))
      this.focus()
      return
    }
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
    const rawLine = this.lineAtY(e.clientY - rect.top)
    if (rawLine < 0) return { line: 0, col: 0 }
    if (rawLine >= this.buffer.lineCount) return this.buffer.clamp({ line: Infinity, col: Infinity })
    const visual = Math.round((e.clientX - rect.left - PAD_LEFT) / this.charWidth)
    return { line: rawLine, col: cmd.colFromVisual(this.buffer.getLine(rawLine), Math.max(visual, 0), this._tabSize) }
  }

  private vertical(delta: number): Position {
    if (this.goalVisual === null) {
      this.goalVisual = cmd.visualCol(this.buffer.getLine(this.cursor.line), this.cursor.col, this._tabSize)
    }
    if (!this.foldMap.isEmpty) {
      // Move by rows on screen, so folded blocks are stepped over.
      const rows = this.foldMap.visibleCount(this.buffer.lineCount)
      const row = this.foldMap.visualLine(this.cursor.line) + delta
      if (row >= 0 && row < rows) delta = this.foldMap.bufferLine(row) - this.cursor.line
    }
    return cmd.moveVertical(this.buffer, this.cursor, delta, this.goalVisual, this._tabSize)
  }

  // ---------- minimap ----------

  private readonly minimap: Minimap
  private minimapOn = true

  /** Show or hide the minimap. */
  setMinimap(on: boolean): void {
    this.minimapOn = on
    this.minimap.setVisible(on && this.hasDoc)
    if (this.hasDoc) this.render(true)
  }

  get minimapVisible(): boolean {
    return this.minimapOn
  }

  /** Room the minimap takes on the right of the text. */
  private get minimapRoom(): number {
    return this.minimapOn && this.hasDoc ? MINIMAP_WIDTH : 0
  }

  // ---------- folding ----------

  private foldMap: FoldMap = FoldMap.empty

  /** Recompute which lines are hidden (after edits or fold changes). */
  private rebuildFolds(): void {
    const b = this.buffer
    const get = (l: number) => b.getLine(l)
    // Forget folds whose block went away (e.g. its body was deleted).
    this.doc.folds = this.doc.folds.filter((h) => h < b.lineCount && foldEnd(get, b.lineCount, h) !== null)
    this.foldMap = this.doc.folds.length ? new FoldMap(this.doc.folds, (h) => foldEnd(get, b.lineCount, h)) : FoldMap.empty
  }

  /** Pixel y of a line's top (hidden lines: their block's header row). */
  private yOf(line: number): number {
    return PAD_TOP + this.foldMap.visualLine(line) * this.lineHeight
  }

  /** The line at a y inside the content (-1 above the text, lineCount below it). */
  private lineAtY(y: number): number {
    const row = Math.floor((y - PAD_TOP) / this.lineHeight)
    if (row < 0) return -1
    if (row >= this.foldMap.visibleCount(this.buffer.lineCount)) return this.buffer.lineCount
    return this.foldMap.bufferLine(row)
  }

  private get getLine(): (l: number) => string {
    const b = this.buffer
    return (l) => b.getLine(l)
  }

  /** Fold the block at `line` (its own, or the one around it). Folding a folded block folds its parent. */
  fold(line = this.cursor.line): void {
    if (!this.hasDoc) return
    const n = this.buffer.lineCount
    let header = enclosingBlock(this.getLine, n, line)
    while (header !== null && this.foldMap.isFolded(header)) {
      // Already folded: go one level out.
      let parent: number | null = null
      for (let h = header - 1; h >= 0; h--) {
        const end = foldEnd(this.getLine, n, h)
        if (end !== null && end >= header) {
          parent = h
          break
        }
      }
      header = parent
    }
    if (header === null) return
    this.setFolds([...this.doc.folds, header])
  }

  /** Unfold the folded block at (or containing) `line`. */
  unfold(line = this.cursor.line): void {
    if (!this.hasDoc) return
    const n = this.buffer.lineCount
    this.setFolds(this.doc.folds.filter((h) => {
      if (h === line) return false
      const end = foldEnd(this.getLine, n, h)
      return !(end !== null && h < line && line <= end)
    }))
  }

  toggleFold(line = this.cursor.line): void {
    if (this.foldMap.isFolded(line)) this.unfold(line)
    else this.fold(line)
  }

  /** Fold every block in the file. */
  foldAll(): void {
    if (!this.hasDoc) return
    const n = this.buffer.lineCount
    const headers: number[] = []
    for (let l = 0; l < n; l++) if (isFoldable(this.getLine, n, l)) headers.push(l)
    this.setFolds(headers)
  }

  unfoldAll(): void {
    if (this.hasDoc) this.setFolds([])
  }

  private setFolds(headers: number[]): void {
    this.doc.folds = [...new Set(headers)].sort((a, b) => a - b)
    this.rebuildFolds()
    // A cursor inside a block that just folded moves up to the block's first line.
    for (const p of [this.cursor, this.anchor]) {
      const range = this.foldMap.rangeOf(p.line)
      if (range) {
        const header = range[0] - 1
        this.cursor = this.anchor = { line: header, col: this.buffer.getLine(header).length }
        this.clearExtras()
        break
      }
    }
    this.render(true)
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
  private render(textChanged = true, scroll: 'nearest' | 'center' | 'none' = 'nearest'): void {
    this.renders++
    if (textChanged) this.rebuildFolds()
    if (this.foldMap.isHidden(this.cursor.line)) {
      // The cursor moved into a folded block (e.g. go to line, find): open it.
      const n = this.buffer.lineCount
      const line = this.cursor.line
      this.doc.folds = this.doc.folds.filter((h) => {
        const end = foldEnd(this.getLine, n, h)
        return !(end !== null && h < line && line <= end)
      })
      this.rebuildFolds()
      textChanged = true
    }
    if (textChanged) this.updateSize()
    this.bracketMatch = this.hasSelection() || this.multi ? null : this.findBracketMatch()
    const { x, y } = this.positionCursor()
    if (scroll !== 'none') this.scrollIntoView(x, y, scroll)
    this.renderLines()
    this.renderSelection()
    this.minimap.schedule()
    this.opts.onCursor?.()
  }

  /** Size the scrollable area to the whole file, even though only visible lines are drawn. */
  private updateSize(): void {
    const lines = this.buffer.getLines()
    let widest = 0
    for (const line of lines) {
      const cols = line.includes('\t') ? cmd.visualCol(line, line.length, this._tabSize) : line.length
      if (cols > widest) widest = cols
    }
    const rows = this.foldMap.visibleCount(lines.length)
    const height = `calc(${PAD_TOP + rows * this.lineHeight}px + 40vh)` // 40vh: let the last line scroll up
    this.content.style.height = height
    this.content.style.width = `${PAD_LEFT + widest * this.charWidth + PAD_RIGHT + this.minimapRoom}px`
    this.gutter.style.height = height
    this.gutter.style.width = `${String(lines.length).length * this.charWidth + GUTTER_PAD}px`
  }

  /** Which screen rows are visible, plus a few extra above and below. */
  private visibleRange(): [number, number] {
    const first = Math.floor((this.root.scrollTop - PAD_TOP) / this.lineHeight) - OVERSCAN
    const count = Math.ceil(this.root.clientHeight / this.lineHeight) + OVERSCAN * 2
    return [Math.max(0, first), Math.min(this.foldMap.visibleCount(this.buffer.lineCount) - 1, first + count)]
  }

  /** Draw just the visible lines, colored by the highlighter. */
  private renderLines(): void {
    const [first, last] = this.visibleRange()
    const lineEls: HTMLElement[] = []
    const numberEls: HTMLElement[] = []
    const n = this.buffer.lineCount
    for (let row = first; row <= last; row++) {
      const i = this.foldMap.bufferLine(row)
      lineEls.push(this.renderLine(i))
      const num = el('div', this.breakpoints.has(i) ? (i === this.execLine ? 'bp exec' : 'bp') : i === this.execLine ? 'exec' : '')
      num.textContent = String(i + 1)
      if (isFoldable(this.getLine, n, i)) {
        const folded = this.foldMap.isFolded(i)
        const toggle = el('span', folded ? 'fold-toggle folded' : 'fold-toggle')
        toggle.textContent = folded ? '▸' : '▾'
        toggle.title = folded ? 'Unfold (Ctrl+Shift+])' : 'Fold (Ctrl+Shift+[)'
        num.append(toggle)
      }
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
    if (this.foldMap.isFolded(index)) {
      const more = el('span', 'fold-placeholder')
      more.textContent = '⋯'
      more.title = 'Folded: click to unfold'
      more.dataset.line = String(index)
      lineEl.append(more)
    }
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
    const line = this.lineAtY(clientY - rect.top)
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
    const y = this.yOf(pos.line)
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
    const firstRow = Math.floor((this.root.scrollTop - PAD_TOP) / this.lineHeight) - 1
    const lastRow = firstRow + Math.ceil(this.root.clientHeight / this.lineHeight) + 2
    const rows = this.foldMap.visibleCount(this.buffer.lineCount)
    const firstVisible = this.foldMap.bufferLine(Math.max(0, firstRow))
    const lastVisible = lastRow >= rows ? this.buffer.lineCount - 1 : this.foldMap.bufferLine(lastRow)
    const boxes: HTMLElement[] = []

    if (this.execLine !== null && this.execLine >= firstVisible && this.execLine <= lastVisible) {
      const box = el('div', 'exec-line')
      box.style.transform = `translateY(${this.yOf(this.execLine)}px)`
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
    if (this.bracketMatch) {
      for (const p of [this.bracketMatch.bracket, this.bracketMatch.match]) {
        if (p.line >= firstVisible && p.line <= lastVisible) {
          this.addBoxes(boxes, p, { line: p.line, col: p.col + 1 }, 'bracket-match', firstVisible, lastVisible)
        }
      }
    }
    // Extra cursors: their selections, plus a drawn cursor each (the main cursor is drawn separately).
    for (const s of this.view.extras) {
      const { start, end } = sel.selectionRange(s)
      if (end.line < firstVisible || start.line > lastVisible) continue
      if (!sel.isEmpty(s)) this.addBoxes(boxes, start, end, 'sel', firstVisible, lastVisible)
      if (this.foldMap.isHidden(s.head.line)) continue
      const x = PAD_LEFT + cmd.visualCol(this.buffer.getLine(s.head.line), s.head.col, this._tabSize) * this.charWidth
      const c = el('div', 'cursor extra-cursor')
      c.style.transform = `translate(${x}px, ${this.yOf(s.head.line)}px)`
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
      if (this.foldMap.isHidden(line)) continue
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
      box.style.transform = `translate(${PAD_LEFT + x1 * this.charWidth}px, ${this.yOf(line)}px)`
      box.style.width = `${width * this.charWidth}px`
      boxes.push(box)
    }
  }

  /** Put the cursor (and hidden textarea) at the cursor position; returns its pixel position. */
  private positionCursor(): { x: number; y: number } {
    const { line, col } = this.cursor
    const x = PAD_LEFT + cmd.visualCol(this.buffer.getLine(line), col, this._tabSize) * this.charWidth
    const y = this.yOf(line)
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
    const visibleText = view.clientWidth - gutterWidth - this.minimapRoom
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
