/**
 * Search logic for find/replace. Pure functions over lines of text.
 * Matches never span lines (one regex run per line), which keeps it simple
 * and fast; multi-line search can come later if needed.
 */
import type { Position } from './textBuffer'
import { TextBuffer, comparePositions } from './textBuffer'
import { buildRegExp, type FindOptions } from '../../shared/regex'

// Re-exported so existing imports from './editor/find' keep working.
export { buildRegExp, escapeRegExp, type FindOptions } from '../../shared/regex'

export interface Match {
  start: Position
  end: Position
}

export function findMatches(
  lines: readonly string[],
  query: string,
  opts: FindOptions,
  limit = 10_000
): { matches: Match[]; error?: string } {
  if (!query) return { matches: [] }
  const re = buildRegExp(query, opts)
  if (typeof re === 'string') return { matches: [], error: re }

  const matches: Match[] = []
  for (let line = 0; line < lines.length && matches.length < limit; line++) {
    const text = lines[line]
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++ // skip zero-length matches like /x*/
        continue
      }
      matches.push({ start: { line, col: m.index }, end: { line, col: m.index + m[0].length } })
      if (matches.length >= limit) break
    }
  }
  return { matches }
}

/**
 * Index of the match to go to from `pos`: the first one starting at/after pos
 * (direction 1) or the last one starting before pos (direction -1), wrapping around.
 */
export function matchIndexFrom(matches: Match[], pos: Position, direction: 1 | -1): number {
  if (matches.length === 0) return -1
  if (direction === 1) {
    const i = matches.findIndex((m) => comparePositions(m.start, pos) >= 0)
    return i === -1 ? 0 : i
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (comparePositions(matches[i].start, pos) < 0) return i
  }
  return matches.length - 1
}

/** The text to put in place of `matched`. In regex mode, $1 etc. refer to capture groups. */
export function replacementFor(matched: string, query: string, replacement: string, opts: FindOptions): string {
  if (!opts.regex) return replacement
  const re = buildRegExp(query, opts, false)
  return typeof re === 'string' ? replacement : matched.replace(re, replacement)
}

/** Replace every match (back to front so earlier positions stay valid). Returns the first match's start. */
export function replaceAll(
  b: TextBuffer, matches: Match[], replacement: string, query: string, opts: FindOptions
): Position {
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const text = replacementFor(b.getRange(m.start, m.end), query, replacement, opts)
    b.delete(m.start, m.end)
    b.insert(m.start, text)
  }
  return matches[0]?.start ?? { line: 0, col: 0 }
}
