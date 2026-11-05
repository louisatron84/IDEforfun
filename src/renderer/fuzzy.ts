/**
 * Fuzzy matching for the command palette and quick open: the query's letters
 * must appear in order, but not necessarily next to each other ("rpf" →
 * "Run Python File"). Matches at word starts and in unbroken runs score
 * higher, so the most likely result comes first.
 */

export interface FuzzyMatch {
  score: number
  /** Indices in the text of each matched character (for bold highlighting). */
  positions: number[]
}

const isBoundary = (ch: string | undefined) => ch === undefined || /[\s/\\_\-.:]/.test(ch)
const isUpper = (ch: string) => ch !== ch.toLowerCase()

function isWordStart(text: string, i: number): boolean {
  if (isBoundary(text[i - 1])) return true
  return isUpper(text[i]) && !isUpper(text[i - 1]) // camelCase hump
}

/**
 * Greedy left-to-right match, preferring word-start positions when one is
 * available later in the text for the same letter.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const positions: number[] = []
  let from = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = t.indexOf(ch, from)
    if (found === -1) return null
    // If this char isn't continuing a run, try to land on a word start instead.
    const continuesRun = positions.length > 0 && found === positions[positions.length - 1] + 1
    if (!continuesRun && !isWordStart(text, found)) {
      for (let j = found + 1; j < t.length; j++) {
        if (t[j] === ch && isWordStart(text, j)) {
          // Only jump if the rest of the query can still match after j.
          if (canMatchRest(q, qi + 1, t, j + 1)) found = j
          break
        }
      }
    }
    positions.push(found)
    from = found + 1
  }

  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k]
    score += 1
    if (p === 0) score += 8
    else if (isWordStart(text, p)) score += 6
    if (k > 0 && p === positions[k - 1] + 1) score += 5
    else if (k > 0) score -= Math.min(3, (p - positions[k - 1] - 1) * 0.5)
  }
  return { score, positions }
}

function canMatchRest(q: string, qi: number, t: string, from: number): boolean {
  for (; qi < q.length; qi++) {
    const f = t.indexOf(q[qi], from)
    if (f === -1) return false
    from = f + 1
  }
  return true
}

export interface FuzzyResult<T> {
  item: T
  match: FuzzyMatch
}

/**
 * Filter and sort items by how well they match. For file paths, matches in
 * the file name (after the last slash) get a bonus.
 */
export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string, limit = 100): FuzzyResult<T>[] {
  const results: (FuzzyResult<T> & { len: number })[] = []
  for (const item of items) {
    const s = text(item)
    const match = fuzzyMatch(query, s)
    if (!match) continue
    const nameStart = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1
    if (nameStart > 0 && match.positions.length > 0 && match.positions[0] >= nameStart) match.score += 10
    results.push({ item, match, len: s.length })
  }
  results.sort((a, b) => b.match.score - a.match.score || a.len - b.len)
  return results.slice(0, limit).map(({ item, match }) => ({ item, match }))
}
