/**
 * Multi-cursor logic, as pure functions (unit-tested without UI).
 *
 * Several selections are edited one after another, top to bottom. Every
 * edit shifts the text after it, so the selections still waiting (and the
 * results already made) are moved along with each change.
 */
import type { Change, Position } from './textBuffer'
import { TextBuffer, comparePositions, endOf } from './textBuffer'
import { type Selection, isEmpty, selectionRange } from './selection'

/** A selection that may be the primary one (the cursor the view follows). */
export interface MultiSelection extends Selection {
  primary?: boolean
}

/**
 * Where `pos` ends up after `change`. `stickAfter`: when text is inserted
 * exactly at `pos`, move `pos` after it (true) or keep it in front (false).
 */
export function mapPosition(pos: Position, change: Change, stickAfter = true): Position {
  const at = change.at
  const end = endOf(at, change.text)
  if (change.kind === 'insert') {
    const cmp = comparePositions(pos, at)
    if (cmp < 0 || (cmp === 0 && !stickAfter)) return pos
    if (pos.line > at.line) return { line: pos.line + (end.line - at.line), col: pos.col }
    // Same line, at or after the insertion point.
    return { line: end.line, col: end.col + (pos.col - at.col) }
  }
  // delete [at, end)
  if (comparePositions(pos, at) <= 0) return pos
  if (comparePositions(pos, end) <= 0) return at
  if (pos.line > end.line) return { line: pos.line - (end.line - at.line), col: pos.col }
  return { line: at.line, col: at.col + (pos.col - end.col) }
}

function mapSelection<T extends Selection>(s: T, change: Change, stickAfter: boolean): T {
  return { ...s, anchor: mapPosition(s.anchor, change, stickAfter), head: mapPosition(s.head, change, stickAfter) }
}

/**
 * Sort selections top to bottom and merge any that overlap or sit on the
 * same spot. A merged selection stays primary if any of its parts was.
 */
export function normalize(selections: readonly MultiSelection[]): MultiSelection[] {
  const sorted = [...selections].sort((a, b) =>
    comparePositions(selectionRange(a).start, selectionRange(b).start)
  )
  const out: MultiSelection[] = []
  for (const s of sorted) {
    const prev = out[out.length - 1]
    if (prev) {
      const p = selectionRange(prev)
      const c = selectionRange(s)
      const touching = comparePositions(c.start, p.end) < 0 || comparePositions(c.start, p.start) === 0 ||
        (comparePositions(c.start, p.end) === 0 && (isEmpty(prev) || isEmpty(s)) && comparePositions(c.end, p.end) === 0)
      if (touching) {
        const end = comparePositions(c.end, p.end) > 0 ? c.end : p.end
        const backwards = comparePositions(prev.head, prev.anchor) < 0
        out[out.length - 1] = {
          anchor: backwards ? end : p.start,
          head: backwards ? p.start : end,
          primary: prev.primary || s.primary
        }
        continue
      }
    }
    out.push({ ...s })
  }
  if (out.length && !out.some((s) => s.primary)) out[out.length - 1].primary = true
  return out
}

/**
 * Run `op` on every selection (top to bottom), keeping the others in step
 * with each change. Returns the resulting selections, normalized.
 */
export function editAll(
  buffer: TextBuffer,
  selections: readonly MultiSelection[],
  op: (s: Selection, index: number) => Selection
): MultiSelection[] {
  const pending = normalize(selections)
  const done: MultiSelection[] = []
  const unsubscribe = buffer.subscribe((change) => {
    // Results already made sit before (or at) the edit: keep them in front of inserted text.
    for (let i = 0; i < done.length; i++) done[i] = mapSelection(done[i], change, false)
    for (let i = 0; i < pending.length; i++) pending[i] = mapSelection(pending[i], change, true)
  })
  try {
    for (let index = 0; pending.length; index++) {
      const s = pending.shift()!
      const result = op({ anchor: s.anchor, head: s.head }, index)
      done.push({ ...result, primary: s.primary })
    }
  } finally {
    unsubscribe()
  }
  return normalize(done)
}

/** Every place `text` occurs (case-sensitive), as selections. */
export function allOccurrences(buffer: TextBuffer, text: string): Selection[] {
  if (!text) return []
  const lines = buffer.getLines()
  const out: Selection[] = []
  if (!text.includes('\n')) {
    for (let line = 0; line < lines.length; line++) {
      let col = lines[line].indexOf(text)
      while (col !== -1) {
        out.push({ anchor: { line, col }, head: { line, col: col + text.length } })
        col = lines[line].indexOf(text, col + text.length)
      }
    }
    return out
  }
  // Multi-line text: search the whole document.
  const full = lines.join('\n')
  const lineStarts: number[] = []
  let offset = 0
  for (const l of lines) {
    lineStarts.push(offset)
    offset += l.length + 1
  }
  const toPos = (o: number): Position => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= o) lo = mid
      else hi = mid - 1
    }
    return { line: lo, col: o - lineStarts[lo] }
  }
  let i = full.indexOf(text)
  while (i !== -1) {
    out.push({ anchor: toPos(i), head: toPos(i + text.length) })
    i = full.indexOf(text, i + text.length)
  }
  return out
}

/**
 * Ctrl+D: the next occurrence of `text` after `after` (wrapping around to
 * the top) that isn't already selected, or null if there is none.
 */
export function nextOccurrence(
  buffer: TextBuffer,
  text: string,
  after: Position,
  existing: readonly Selection[]
): Selection | null {
  const all = allOccurrences(buffer, text)
  const taken = (s: Selection) =>
    existing.some((e) => {
      const r = selectionRange(e)
      return comparePositions(r.start, s.anchor) === 0 && comparePositions(r.end, s.head) === 0
    })
  const ordered = [
    ...all.filter((s) => comparePositions(s.anchor, after) >= 0),
    ...all.filter((s) => comparePositions(s.anchor, after) < 0)
  ]
  return ordered.find((s) => !taken(s)) ?? null
}
