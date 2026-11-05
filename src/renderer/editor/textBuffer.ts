/** A place in the text. `line` and `col` are 0-based; `col` counts characters. */
export interface Position {
  line: number
  col: number
}

/**
 * One low-level change. `text` always uses '\n' for line breaks.
 * insert: `text` was inserted at `at`. delete: `text` was removed starting at `at`.
 */
export interface Change {
  kind: 'insert' | 'delete'
  at: Position
  text: string
}

/** The position just after `text` if it were inserted at `at`. */
export function endOf(at: Position, text: string): Position {
  const pieces = splitLines(text)
  if (pieces.length === 1) return { line: at.line, col: at.col + text.length }
  return { line: at.line + pieces.length - 1, col: pieces[pieces.length - 1].length }
}

export function comparePositions(a: Position, b: Position): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col
}

/**
 * The editor's model of a file: an array of lines (without line endings).
 *
 * An array of lines is the simplest structure that is fast enough for normal
 * source files, since edits only touch one or a few lines. Big editors use
 * piece tables or ropes; we can swap that in later behind this same API.
 */
export class TextBuffer {
  private lines: string[]
  /** Line ending used when saving: kept the same as the file had. */
  eol: '\n' | '\r\n'
  private readonly listeners = new Set<(change: Change) => void>()

  /** Get told about every change (History uses it for undo, Highlighter to re-color). */
  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: Change): void {
    for (const listener of this.listeners) listener(change)
  }

  constructor(text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n'
    this.lines = splitLines(text)
  }

  get lineCount(): number {
    return this.lines.length
  }

  getLine(line: number): string {
    return this.lines[line] ?? ''
  }

  getLines(): readonly string[] {
    return this.lines
  }

  getText(): string {
    return this.lines.join(this.eol)
  }

  clamp(pos: Position): Position {
    const line = Math.min(Math.max(pos.line, 0), this.lines.length - 1)
    const col = Math.min(Math.max(pos.col, 0), this.lines[line].length)
    return { line, col }
  }

  /** Insert `text` at `pos`; returns the position just after the inserted text. */
  insert(pos: Position, text: string): Position {
    const at = this.clamp(pos)
    if (text === '') return at
    const current = this.lines[at.line]
    const before = current.slice(0, at.col)
    const after = current.slice(at.col)
    const pieces = splitLines(text)

    if (pieces.length === 1) {
      this.lines[at.line] = before + text + after
    } else {
      const last = pieces[pieces.length - 1]
      this.lines.splice(at.line, 1, before + pieces[0], ...pieces.slice(1, -1), last + after)
    }
    const normalized = pieces.join('\n')
    this.emit({ kind: 'insert', at, text: normalized })
    return endOf(at, normalized)
  }

  /** The text between two positions (in either order), with '\n' line breaks. */
  getRange(a: Position, b: Position): string {
    let start = this.clamp(a)
    let end = this.clamp(b)
    if (comparePositions(start, end) > 0) [start, end] = [end, start]
    if (start.line === end.line) return this.lines[start.line].slice(start.col, end.col)
    return [
      this.lines[start.line].slice(start.col),
      ...this.lines.slice(start.line + 1, end.line),
      this.lines[end.line].slice(0, end.col)
    ].join('\n')
  }

  /** Delete the text between two positions (in either order). */
  delete(a: Position, b: Position): void {
    let start = this.clamp(a)
    let end = this.clamp(b)
    if (comparePositions(start, end) > 0) [start, end] = [end, start]
    if (comparePositions(start, end) === 0) return
    const removed = this.listeners.size > 0 ? this.getRange(start, end) : ''
    const head = this.lines[start.line].slice(0, start.col)
    const tail = this.lines[end.line].slice(end.col)
    this.lines.splice(start.line, end.line - start.line + 1, head + tail)
    this.emit({ kind: 'delete', at: start, text: removed })
  }

  /** Character offset of a position, counting each line break as 1 character. */
  offsetAt(pos: Position): number {
    const { line, col } = this.clamp(pos)
    let offset = 0
    for (let i = 0; i < line; i++) offset += this.lines[i].length + 1
    return offset + col
  }

  positionAt(offset: number): Position {
    let remaining = Math.max(0, offset)
    for (let line = 0; line < this.lines.length; line++) {
      const len = this.lines[line].length
      if (remaining <= len) return { line, col: remaining }
      remaining -= len + 1
    }
    const last = this.lines.length - 1
    return { line: last, col: this.lines[last].length }
  }
}

/** Split on \n, \r\n or \r. An empty string is one empty line. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}
