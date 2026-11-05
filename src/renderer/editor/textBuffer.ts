/** A place in the text. `line` and `col` are 0-based; `col` counts characters. */
export interface Position {
  line: number
  col: number
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
  readonly eol: '\n' | '\r\n'

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
    const { line, col } = this.clamp(pos)
    const current = this.lines[line]
    const before = current.slice(0, col)
    const after = current.slice(col)
    const pieces = splitLines(text)

    if (pieces.length === 1) {
      this.lines[line] = before + text + after
      return { line, col: col + text.length }
    }
    const last = pieces[pieces.length - 1]
    const newLines = [before + pieces[0], ...pieces.slice(1, -1), last + after]
    this.lines.splice(line, 1, ...newLines)
    return { line: line + pieces.length - 1, col: last.length }
  }

  /** Delete the text between two positions (in either order). */
  delete(a: Position, b: Position): void {
    let start = this.clamp(a)
    let end = this.clamp(b)
    if (comparePositions(start, end) > 0) [start, end] = [end, start]
    const head = this.lines[start.line].slice(0, start.col)
    const tail = this.lines[end.line].slice(end.col)
    this.lines.splice(start.line, end.line - start.line + 1, head + tail)
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
