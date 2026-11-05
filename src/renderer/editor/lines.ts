/** Keeping line-based markers (breakpoints, folded blocks) on their code as text is edited. */
import type { Change } from './textBuffer'

const newlines = (text: string) => text.split('\n').length - 1

/** Where line markers (breakpoints, folds) end up after one edit. Result is sorted, without duplicates. */
export function shiftLines(lines: readonly number[], change: Change): number[] {
  const n = newlines(change.text)
  if (n === 0) return [...lines]
  const L = change.at.line
  const out: number[] = []
  if (change.kind === 'insert') {
    // Enter at the very start of a line pushes that line (and its breakpoint) down.
    for (const b of lines) out.push(b > L || (b === L && change.at.col === 0) ? b + n : b)
  } else if (change.at.col === 0 && change.text.endsWith('\n')) {
    // Whole lines L .. L+n-1 removed (e.g. cut line): their breakpoints go too.
    for (const b of lines) {
      if (b < L) out.push(b)
      else if (b >= L + n) out.push(b - n)
    }
  } else {
    // Lines L+1 .. L+n joined onto line L.
    for (const b of lines) out.push(b <= L ? b : b <= L + n ? L : b - n)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}
