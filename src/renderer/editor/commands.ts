/**
 * Editing and cursor commands, written as plain functions of (buffer, position)
 * so they can be unit-tested without any UI. Each one returns the new cursor.
 */
import type { Position } from './textBuffer'
import { TextBuffer } from './textBuffer'

// ---------- tabs & columns ----------

/** On-screen column of character `col`, with tabs expanded to tab stops. */
export function visualCol(lineText: string, col: number, tabSize: number): number {
  let v = 0
  for (let i = 0; i < col && i < lineText.length; i++) {
    v = lineText[i] === '\t' ? (Math.floor(v / tabSize) + 1) * tabSize : v + 1
  }
  return v
}

/** Character column whose on-screen position is nearest to visual column `target`. */
export function colFromVisual(lineText: string, target: number, tabSize: number): number {
  let v = 0
  for (let i = 0; i < lineText.length; i++) {
    const next = lineText[i] === '\t' ? (Math.floor(v / tabSize) + 1) * tabSize : v + 1
    if (target < next) return target - v <= next - target ? i : i + 1
    v = next
  }
  return lineText.length
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)![0]
}

// ---------- movement ----------

export function moveLeft(b: TextBuffer, pos: Position): Position {
  if (pos.col > 0) return { line: pos.line, col: pos.col - 1 }
  if (pos.line > 0) return { line: pos.line - 1, col: b.getLine(pos.line - 1).length }
  return pos
}

export function moveRight(b: TextBuffer, pos: Position): Position {
  if (pos.col < b.getLine(pos.line).length) return { line: pos.line, col: pos.col + 1 }
  if (pos.line < b.lineCount - 1) return { line: pos.line + 1, col: 0 }
  return pos
}

/** "Smart" Home: first non-space character, or column 0 if already there. */
export function moveHome(b: TextBuffer, pos: Position): Position {
  const indent = leadingWhitespace(b.getLine(pos.line)).length
  return { line: pos.line, col: pos.col === indent ? 0 : indent }
}

export function moveEnd(b: TextBuffer, pos: Position): Position {
  return { line: pos.line, col: b.getLine(pos.line).length }
}

/**
 * Move `delta` lines up/down. `goalVisual` is the on-screen column the user
 * started from, so moving through a short line doesn't lose the column.
 */
export function moveVertical(
  b: TextBuffer,
  pos: Position,
  delta: number,
  goalVisual: number,
  tabSize: number
): Position {
  const target = pos.line + delta
  if (target < 0) return { line: 0, col: 0 }
  if (target > b.lineCount - 1) {
    const last = b.lineCount - 1
    return { line: last, col: b.getLine(last).length }
  }
  return { line: target, col: colFromVisual(b.getLine(target), goalVisual, tabSize) }
}

// ---------- editing ----------

export function backspace(b: TextBuffer, pos: Position, tabSize: number): Position {
  if (pos.col === 0) {
    if (pos.line === 0) return pos
    const prev = { line: pos.line - 1, col: b.getLine(pos.line - 1).length }
    b.delete(prev, pos)
    return prev
  }
  const before = b.getLine(pos.line).slice(0, pos.col)
  // Inside leading spaces: remove back to the previous indent stop.
  const width = /^ +$/.test(before) ? ((pos.col - 1) % tabSize) + 1 : 1
  const start = { line: pos.line, col: pos.col - width }
  b.delete(start, pos)
  return start
}

export function deleteForward(b: TextBuffer, pos: Position): Position {
  b.delete(pos, moveRight(b, pos))
  return pos
}

/** Python's rule: a block opener ends with `:` (ignoring a comment). */
export const pythonIndentAfter = (before: string): boolean => before.replace(/#.*$/, '').trimEnd().endsWith(':')

/** Enter: keep the indentation, plus one level when `indentAfter` says the line opens a block. */
export function newline(b: TextBuffer, pos: Position, tabSize: number, indentAfter: (before: string) => boolean = pythonIndentAfter): Position {
  const lineText = b.getLine(pos.line)
  const before = lineText.slice(0, pos.col)
  let indent = leadingWhitespace(before)
  if (indentAfter(before)) indent += ' '.repeat(tabSize)

  // Text after the cursor moves down; drop its leading spaces so it lines up with the indent.
  const restSpaces = leadingWhitespace(lineText.slice(pos.col)).length
  if (restSpaces > 0) b.delete(pos, { line: pos.line, col: pos.col + restSpaces })
  return b.insert(pos, '\n' + indent)
}

/** Tab: insert spaces up to the next tab stop (Python style, no tab characters). */
export function insertTab(b: TextBuffer, pos: Position, tabSize: number): Position {
  const v = visualCol(b.getLine(pos.line), pos.col, tabSize)
  return b.insert(pos, ' '.repeat(tabSize - (v % tabSize)))
}
