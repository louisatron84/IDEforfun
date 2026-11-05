/**
 * Selections and word-based logic, as pure functions (unit-tested without UI).
 *
 * A selection has an `anchor` (where it started) and a `head` (where the
 * cursor is now). The head can be before the anchor when selecting backwards.
 * An empty selection (anchor == head) is just a cursor.
 */
import type { Position } from './textBuffer'
import { TextBuffer, comparePositions } from './textBuffer'

export interface Selection {
  anchor: Position
  head: Position
}

export function isEmpty(s: Selection): boolean {
  return comparePositions(s.anchor, s.head) === 0
}

export function selectionRange(s: Selection): { start: Position; end: Position } {
  return comparePositions(s.anchor, s.head) <= 0
    ? { start: s.anchor, end: s.head }
    : { start: s.head, end: s.anchor }
}

/** Delete the selected text; returns where the cursor ends up (the start). */
export function deleteSelection(b: TextBuffer, s: Selection): Position {
  const { start, end } = selectionRange(s)
  b.delete(start, end)
  return start
}

// ---------- words ----------

type CharClass = 'word' | 'space' | 'punct'

function classOf(ch: string): CharClass {
  if (/[\p{L}\p{N}_]/u.test(ch)) return 'word'
  if (ch === ' ' || ch === '\t') return 'space'
  return 'punct'
}

/**
 * The [start, end) columns to select on double-click at `col`. Prefers the
 * character under the cursor, but if that's a space/end of line and the one
 * before is a word, selects the word before (clicking just after a word).
 */
export function wordAt(lineText: string, col: number): [number, number] {
  if (lineText.length === 0) return [0, 0]
  let i = Math.min(col, lineText.length - 1)
  if (i > 0 && classOf(lineText[i - 1]) === 'word' && classOf(lineText[i]) !== 'word') i--
  const cls = classOf(lineText[i])
  if (cls === 'punct') return [i, i + 1]
  let start = i
  let end = i + 1
  while (start > 0 && classOf(lineText[start - 1]) === cls) start--
  while (end < lineText.length && classOf(lineText[end]) === cls) end++
  return [start, end]
}

/** Ctrl+Right: skip spaces, then a run of word characters (or one punctuation run). */
export function wordRight(b: TextBuffer, pos: Position): Position {
  const text = b.getLine(pos.line)
  if (pos.col >= text.length) {
    return pos.line < b.lineCount - 1 ? { line: pos.line + 1, col: 0 } : pos
  }
  let i = pos.col
  while (i < text.length && classOf(text[i]) === 'space') i++
  if (i < text.length) {
    const cls = classOf(text[i])
    while (i < text.length && classOf(text[i]) === cls) i++
  }
  return { line: pos.line, col: i }
}

/** Ctrl+Left: the mirror image of wordRight. */
export function wordLeft(b: TextBuffer, pos: Position): Position {
  if (pos.col === 0) {
    return pos.line > 0 ? { line: pos.line - 1, col: b.getLine(pos.line - 1).length } : pos
  }
  const text = b.getLine(pos.line)
  let i = pos.col
  while (i > 0 && classOf(text[i - 1]) === 'space') i--
  if (i > 0) {
    const cls = classOf(text[i - 1])
    while (i > 0 && classOf(text[i - 1]) === cls) i--
  }
  return { line: pos.line, col: i }
}

// ---------- indent / dedent ----------

/** Lines touched by a selection. A selection ending at column 0 doesn't include that last line. */
export function selectedLines(s: Selection): [number, number] {
  const { start, end } = selectionRange(s)
  const last = end.col === 0 && end.line > start.line ? end.line - 1 : end.line
  return [start.line, last]
}

function shift(pos: Position, first: number, last: number, delta: (line: number) => number): Position {
  if (pos.line < first || pos.line > last) return pos
  return { line: pos.line, col: Math.max(0, pos.col + delta(pos.line)) }
}

/** Tab with a multi-line selection: add one indent level to each non-empty line. */
export function indentLines(b: TextBuffer, s: Selection, tabSize: number): Selection {
  const [first, last] = selectedLines(s)
  const unit = ' '.repeat(tabSize)
  const added = new Map<number, number>()
  for (let line = first; line <= last; line++) {
    if (b.getLine(line).length === 0) continue
    b.insert({ line, col: 0 }, unit)
    added.set(line, tabSize)
  }
  const delta = (line: number) => added.get(line) ?? 0
  return { anchor: shift(s.anchor, first, last, delta), head: shift(s.head, first, last, delta) }
}

/** Shift+Tab: remove up to one indent level from each selected line. */
export function dedentLines(b: TextBuffer, s: Selection, tabSize: number): Selection {
  const [first, last] = selectedLines(s)
  const removed = new Map<number, number>()
  for (let line = first; line <= last; line++) {
    const text = b.getLine(line)
    const n = text.startsWith('\t') ? 1 : /^ */.exec(text)![0].length
    const count = Math.min(n, tabSize)
    if (count === 0) continue
    b.delete({ line, col: 0 }, { line, col: count })
    removed.set(line, count)
  }
  const delta = (line: number) => -(removed.get(line) ?? 0)
  return { anchor: shift(s.anchor, first, last, delta), head: shift(s.head, first, last, delta) }
}
