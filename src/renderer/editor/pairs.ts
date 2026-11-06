/**
 * Brackets and quotes: auto-closing, typing over closers, deleting empty
 * pairs, Enter between brackets, finding the matching bracket, and
 * toggling line comments. Pure functions (unit-tested without UI).
 */
import type { Position } from './textBuffer'
import { TextBuffer, comparePositions } from './textBuffer'
import { type Selection, isEmpty, selectedLines, selectionRange } from './selection'

const OPEN_TO_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const QUOTES = new Set(['"', "'"])

/** Characters after which it's fine to auto-insert a closing bracket/quote. */
const closesBefore = (ch: string | undefined) => ch === undefined || /[\s)\]}:;,.]/.test(ch)
const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
/** Python string prefixes: f"...", r'...', b"...", rb"...". */
const STRING_PREFIX = /(^|[^\p{L}\p{N}_])(f|r|b|u|rb|br|fr|rf)$/iu

const cursor = (p: Position): Selection => ({ anchor: p, head: p })

/**
 * Typing one character, with bracket/quote help. Returns the new selection,
 * or null when nothing special applies (the caller then inserts normally).
 * `pythonStrings`: string prefixes (f"...") and docstrings ("""|""").
 */
export function typeChar(b: TextBuffer, s: Selection, ch: string, pythonStrings = true): Selection | null {
  const isOpen = ch in OPEN_TO_CLOSE
  const isClose = ch in CLOSE_TO_OPEN
  const isQuote = QUOTES.has(ch)
  if (!isOpen && !isClose && !isQuote) return null

  // With a selection: wrap it in brackets/quotes, keeping it selected.
  if (!isEmpty(s)) {
    if (isClose) return null
    const { start, end } = selectionRange(s)
    const close = isQuote ? ch : OPEN_TO_CLOSE[ch]
    b.insert(end, close)
    b.insert(start, ch)
    const shift = (p: Position) => (p.line === start.line ? { line: p.line, col: p.col + 1 } : p)
    return { anchor: shift(s.anchor), head: shift(s.head) }
  }

  const pos = s.head
  const line = b.getLine(pos.line)
  const next = line[pos.col]
  const prev = line[pos.col - 1]

  // Typing the closer that's already there: just step over it.
  if ((isClose || isQuote) && next === ch) {
    // ...except a third quote: "" + " makes a docstring """|"""
    if (!(pythonStrings && isQuote && prev === ch && line[pos.col - 2] === ch)) return cursor({ line: pos.line, col: pos.col + 1 })
  }
  if (isOpen) {
    if (!closesBefore(next)) return null
    b.insert(pos, ch + OPEN_TO_CLOSE[ch])
    return cursor({ line: pos.line, col: pos.col + 1 })
  }
  if (isQuote) {
    // Third quote of a docstring: """|"""
    if (pythonStrings && prev === ch && line[pos.col - 2] === ch && line[pos.col - 3] !== ch) {
      b.insert(pos, ch + ch + ch + ch)
      return cursor({ line: pos.line, col: pos.col + 1 })
    }
    // Don't pair after a word (it's an apostrophe: don't, it's), unless it's a string prefix like f"
    const before = line.slice(0, pos.col)
    if (isWordChar(prev) && !(pythonStrings && STRING_PREFIX.test(before))) return null
    if (prev === ch) return null
    if (!closesBefore(next)) return null
    b.insert(pos, ch + ch)
    return cursor({ line: pos.line, col: pos.col + 1 })
  }
  return null
}

/** Backspace inside an empty pair, e.g. (|) or "|": delete both. Returns the new cursor, or null. */
export function backspacePair(b: TextBuffer, pos: Position): Position | null {
  const line = b.getLine(pos.line)
  const prev = line[pos.col - 1]
  const next = line[pos.col]
  if (prev === undefined || next === undefined) return null
  const paired = OPEN_TO_CLOSE[prev] === next || (QUOTES.has(prev) && next === prev && line[pos.col - 2] !== prev)
  if (!paired) return null
  b.delete({ line: pos.line, col: pos.col - 1 }, { line: pos.line, col: pos.col + 1 })
  return { line: pos.line, col: pos.col - 1 }
}

/**
 * Enter between brackets, e.g. foo(|): put the cursor on its own indented
 * line with the closer below. Returns the new cursor, or null.
 */
export function newlineBetweenBrackets(b: TextBuffer, pos: Position, tabSize: number): Position | null {
  const line = b.getLine(pos.line)
  const prev = line.slice(0, pos.col).trimEnd().at(-1)
  const nextIndex = line.slice(pos.col).search(/\S/)
  const next = nextIndex === -1 ? undefined : line[pos.col + nextIndex]
  if (!prev || !next || OPEN_TO_CLOSE[prev] !== next) return null
  const indent = /^[ \t]*/.exec(line)![0]
  const inner = indent + ' '.repeat(tabSize)
  // Remove spaces around the cursor, then: newline + inner indent | newline + indent + closer
  const before = line.slice(0, pos.col).trimEnd().length
  b.delete({ line: pos.line, col: before }, { line: pos.line, col: pos.col + nextIndex })
  b.insert({ line: pos.line, col: before }, '\n' + inner + '\n' + indent)
  return { line: pos.line + 1, col: inner.length }
}

/**
 * The bracket matching the one at or just before `pos`, skipping brackets
 * where `isCode` says no (inside strings and comments).
 */
export function findMatchingBracket(
  b: TextBuffer,
  pos: Position,
  isCode: (line: number, col: number) => boolean,
  maxLines = 5000
): { bracket: Position; match: Position } | null {
  const line = b.getLine(pos.line)
  // Prefer the bracket right after the cursor, then the one right before.
  for (const col of [pos.col, pos.col - 1]) {
    const ch = line[col]
    if (col < 0 || !ch || !(ch in OPEN_TO_CLOSE || ch in CLOSE_TO_OPEN) || !isCode(pos.line, col)) continue
    const forward = ch in OPEN_TO_CLOSE
    const want = forward ? OPEN_TO_CLOSE[ch] : CLOSE_TO_OPEN[ch]
    let depth = 0
    let l = pos.line
    let c = col
    const lastLine = Math.min(b.lineCount - 1, pos.line + maxLines)
    const firstLine = Math.max(0, pos.line - maxLines)
    for (;;) {
      const text = b.getLine(l)
      const cur = text[c]
      if (cur !== undefined && (cur === ch || cur === want) && isCode(l, c)) {
        depth += cur === ch ? 1 : -1
        if (depth === 0) return { bracket: { line: pos.line, col }, match: { line: l, col: c } }
      }
      if (forward) {
        c++
        if (c >= text.length) {
          if (++l > lastLine) break
          c = 0
          // Skip empty lines quickly.
          while (l <= lastLine && b.getLine(l).length === 0) l++
          if (l > lastLine) break
        }
      } else {
        c--
        if (c < 0) {
          if (--l < firstLine) break
          while (l >= firstLine && b.getLine(l).length === 0) l--
          if (l < firstLine) break
          c = b.getLine(l).length - 1
        }
      }
    }
    return null
  }
  return null
}

/**
 * Ctrl+/: comment the selected lines with "# " (or the language's marker),
 * or uncomment them if they all are already. Returns the selection adjusted to the edit.
 */
export function toggleComment(b: TextBuffer, s: Selection, marker = '#'): Selection {
  const [first, last] = selectedLines(s)
  const lines: number[] = []
  for (let l = first; l <= last; l++) if (b.getLine(l).trim()) lines.push(l)
  if (!lines.length) return s
  const allCommented = lines.every((l) => b.getLine(l).trimStart().startsWith(marker))
  const delta = new Map<number, { col: number; by: number }>()
  if (allCommented) {
    for (const l of lines) {
      const text = b.getLine(l)
      const col = text.indexOf(marker)
      const len = marker.length + (text[col + marker.length] === ' ' ? 1 : 0)
      b.delete({ line: l, col }, { line: l, col: col + len })
      delta.set(l, { col, by: -len })
    }
  } else {
    // Line the #s up at the smallest indentation of the selected lines.
    const indent = Math.min(...lines.map((l) => /^[ \t]*/.exec(b.getLine(l))![0].length))
    for (const l of lines) {
      b.insert({ line: l, col: indent }, marker + ' ')
      delta.set(l, { col: indent, by: marker.length + 1 })
    }
  }
  const adjust = (p: Position): Position => {
    const d = delta.get(p.line)
    if (!d) return p
    if (d.by > 0) return p.col >= d.col ? { line: p.line, col: p.col + d.by } : p
    // Removed text: positions inside it move to its start.
    if (p.col <= d.col) return p
    return { line: p.line, col: Math.max(d.col, p.col + d.by) }
  }
  // An empty selection stays a cursor that moved with its line's text.
  const anchor = adjust(s.anchor)
  const head = adjust(s.head)
  return comparePositions(s.anchor, s.head) === 0 ? { anchor: head, head } : { anchor, head }
}
