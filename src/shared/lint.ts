/**
 * Ruff's lint results, and turning a tool's rewritten text (formatting,
 * sorted imports) into the smallest edit, so the cursor and undo stay sensible.
 */

export interface Pos {
  line: number
  col: number
}

export interface Edit {
  start: Pos
  end: Pos
  text: string
}

export interface LintProblem {
  /** Rule code, e.g. F401. */
  code: string
  message: string
  start: Pos
  end: Pos
  /** Ruff's fix for it, if it has one. */
  fix?: { title: string; edits: Edit[]; safe: boolean }
  url?: string
}

const loc = (l: unknown): Pos | null => {
  const r = l as { row?: unknown; column?: unknown }
  return typeof r?.row === 'number' && typeof r.column === 'number' ? { line: r.row - 1, col: r.column - 1 } : null
}

/** `ruff check --output-format=json` → problems (0-based positions). */
export function parseRuffJson(json: string): LintProblem[] {
  let data: unknown
  try {
    data = JSON.parse(json.trim() || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: LintProblem[] = []
  for (const d of data) {
    const start = loc(d?.location)
    const end = loc(d?.end_location) ?? start
    if (!start || !end || typeof d.message !== 'string') continue
    // Syntax errors have no code.
    const p: LintProblem = { code: typeof d.code === 'string' ? d.code : 'syntax', message: d.message, start, end }
    if (typeof d.url === 'string') p.url = d.url
    if (d.fix && Array.isArray(d.fix.edits)) {
      const edits: Edit[] = []
      for (const e of d.fix.edits) {
        const s = loc(e?.location)
        const t = loc(e?.end_location)
        if (s && t && typeof e.content === 'string') edits.push({ start: s, end: t, text: e.content })
      }
      if (edits.length) {
        p.fix = {
          title: typeof d.fix.message === 'string' && d.fix.message ? d.fix.message : `Fix ${p.code}`,
          edits,
          safe: d.fix.applicability !== 'unsafe' && d.fix.applicability !== 'display-only'
        }
      }
    }
    out.push(p)
  }
  return out
}

/**
 * The smallest whole-line edit that turns `before` into `after` (same lines
 * at the start and end are left alone), or null if they're the same.
 * Positions are in `before`'s lines.
 */
export function lineDiff(before: string, after: string): Edit | null {
  if (before === after) return null
  const a = before.split('\n')
  const b = after.split('\n')
  let top = 0
  while (top < a.length && top < b.length && a[top] === b[top]) top++
  let bottom = 0
  while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++
  const aEnd = a.length - bottom // exclusive
  const bEnd = b.length - bottom
  // Replace lines top..aEnd-1 of `before` with lines top..bEnd-1 of `after`.
  if (aEnd > top) {
    // Lines removed and none added in their place: delete them with their line breaks.
    if (bEnd === top) return deleteLines(a, top, aEnd)
    // Otherwise replace the changed lines' text (the line break after them stays).
    return { start: { line: top, col: 0 }, end: { line: aEnd - 1, col: a[aEnd - 1].length }, text: b.slice(top, bEnd).join('\n') }
  }
  // Only insertions: put the new lines before line `top`.
  const inserted = b.slice(top, bEnd).join('\n') + '\n'
  if (top < a.length) return { start: { line: top, col: 0 }, end: { line: top, col: 0 }, text: inserted }
  // At the very end (after the last line).
  const last = a.length - 1
  return { start: { line: last, col: a[last].length }, end: { line: last, col: a[last].length }, text: '\n' + b.slice(top, bEnd).join('\n') }
}

/** Remove whole lines top..end-1, including their line breaks. */
function deleteLines(a: string[], top: number, end: number): Edit {
  if (end < a.length) return { start: { line: top, col: 0 }, end: { line: end, col: 0 }, text: '' }
  // Deleting through the last line: take the line break before them instead.
  if (top === 0) return { start: { line: 0, col: 0 }, end: { line: end - 1, col: a[end - 1].length }, text: '' }
  return { start: { line: top - 1, col: a[top - 1].length }, end: { line: end - 1, col: a[end - 1].length }, text: '' }
}

/** Apply an edit to text (for checking lineDiff). */
export function applyEdit(text: string, e: Edit): string {
  const lines = text.split('\n')
  const off = (p: Pos) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.col
  return text.slice(0, off(e.start)) + e.text + text.slice(off(e.end))
}
