/**
 * Code folding: which blocks can fold (by indentation, which is how Python
 * marks blocks) and the mapping between file lines and the rows on screen
 * once some blocks are folded. Pure logic (unit-tested without UI).
 */

const indentOf = (text: string) => /^[ \t]*/.exec(text)![0].replace(/\t/g, '    ').length
const isBlank = (text: string) => text.trim() === ''

/** True if `line` starts a block: the next non-blank line is indented deeper. */
export function isFoldable(getLine: (l: number) => string, lineCount: number, line: number): boolean {
  const text = getLine(line)
  if (isBlank(text)) return false
  for (let l = line + 1; l < lineCount; l++) {
    const t = getLine(l)
    if (!isBlank(t)) return indentOf(t) > indentOf(text)
  }
  return false
}

/**
 * The last line of the block starting at `line` (the deeper-indented lines
 * after it, not counting trailing blank lines), or null if it isn't a block.
 */
export function foldEnd(getLine: (l: number) => string, lineCount: number, line: number): number | null {
  const text = getLine(line)
  if (isBlank(text)) return null
  const indent = indentOf(text)
  let end = -1
  for (let l = line + 1; l < lineCount; l++) {
    const t = getLine(l)
    if (isBlank(t)) continue
    if (indentOf(t) <= indent) break
    end = l
  }
  return end === -1 ? null : end
}

/**
 * The block to fold for a cursor on `line`: the line's own block if it
 * starts one, else the nearest enclosing block. Returns its header line.
 */
export function enclosingBlock(getLine: (l: number) => string, lineCount: number, line: number): number | null {
  if (isFoldable(getLine, lineCount, line)) return line
  for (let h = line - 1; h >= 0; h--) {
    const end = foldEnd(getLine, lineCount, h)
    if (end !== null && end >= line) return h
  }
  return null
}

/** Folded blocks of a document, and the file line ↔ screen row mapping. */
export class FoldMap {
  /** Hidden line ranges [from, to] (inclusive), sorted and not overlapping. */
  readonly ranges: readonly [number, number][]
  readonly hiddenCount: number

  constructor(headers: readonly number[], rangeEnd: (header: number) => number | null) {
    const ranges: [number, number][] = []
    for (const h of [...headers].sort((a, b) => a - b)) {
      const last = ranges[ranges.length - 1]
      if (last && h <= last[1]) continue // inside a block that's already folded away
      const end = rangeEnd(h)
      if (end !== null && end > h) ranges.push([h + 1, end])
    }
    this.ranges = ranges
    this.hiddenCount = ranges.reduce((n, [from, to]) => n + to - from + 1, 0)
  }

  static readonly empty = new FoldMap([], () => null)

  get isEmpty(): boolean {
    return this.ranges.length === 0
  }

  /** The folded header lines that actually hide something. */
  get headers(): number[] {
    return this.ranges.map(([from]) => from - 1)
  }

  /** The hidden range containing `line`, if any. */
  rangeOf(line: number): [number, number] | undefined {
    let lo = 0
    let hi = this.ranges.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const [from, to] = this.ranges[mid]
      if (line < from) hi = mid - 1
      else if (line > to) lo = mid + 1
      else return this.ranges[mid]
    }
    return undefined
  }

  isHidden(line: number): boolean {
    return this.rangeOf(line) !== undefined
  }

  isFolded(header: number): boolean {
    return this.rangeOf(header + 1)?.[0] === header + 1
  }

  /** The screen row of a file line (a hidden line maps to its block's header row). */
  visualLine(line: number): number {
    let hidden = 0
    for (const [from, to] of this.ranges) {
      if (from > line) break
      if (line <= to) return from - 1 - hidden
      hidden += to - from + 1
    }
    return line - hidden
  }

  /** The file line shown on a screen row. */
  bufferLine(row: number): number {
    let line = row
    for (const [from, to] of this.ranges) {
      if (from <= line) line += to - from + 1
      else break
    }
    return line
  }

  visibleCount(lineCount: number): number {
    return lineCount - this.hiddenCount
  }
}
