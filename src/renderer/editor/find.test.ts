import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import { History } from './history'
import { findMatches, matchIndexFrom, replaceAll, replacementFor } from './find'

const p = (line: number, col: number) => ({ line, col })
const opts = (o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }> = {}) =>
  ({ caseSensitive: false, wholeWord: false, regex: false, ...o })

describe('findMatches', () => {
  const lines = ['Foo foo food', 'bar.foo()', '']
  it('finds plain text, case-insensitive by default', () => {
    const { matches } = findMatches(lines, 'foo', opts())
    expect(matches).toEqual([
      { start: p(0, 0), end: p(0, 3) }, { start: p(0, 4), end: p(0, 7) },
      { start: p(0, 8), end: p(0, 11) }, { start: p(1, 4), end: p(1, 7) }
    ])
  })
  it('respects case sensitivity and whole words', () => {
    expect(findMatches(lines, 'Foo', opts({ caseSensitive: true })).matches).toHaveLength(1)
    expect(findMatches(lines, 'foo', opts({ wholeWord: true })).matches).toHaveLength(3) // not "food"
  })
  it('treats regex characters literally unless regex mode is on', () => {
    expect(findMatches(lines, '.foo(', opts()).matches).toEqual([{ start: p(1, 3), end: p(1, 8) }])
    expect(findMatches(lines, 'fo+d?', opts({ regex: true })).matches).toHaveLength(4)
  })
  it('reports invalid regexes instead of throwing', () => {
    const r = findMatches(lines, '(', opts({ regex: true }))
    expect(r.matches).toEqual([])
    expect(r.error).toBeTruthy()
  })
  it('ignores empty queries and zero-length regex matches', () => {
    expect(findMatches(lines, '', opts()).matches).toEqual([])
    expect(findMatches(lines, 'x*', opts({ regex: true })).matches).toEqual([])
  })
  it('stops at the limit', () => {
    const many = Array.from({ length: 100 }, () => 'aaaa')
    expect(findMatches(many, 'a', opts(), 50).matches).toHaveLength(50)
  })
})

describe('matchIndexFrom (next / previous)', () => {
  const matches = findMatches(['ab ab', 'ab'], 'ab', opts()).matches // (0,0) (0,3) (1,0)
  it('finds the next match at or after a position, wrapping to the first', () => {
    expect(matchIndexFrom(matches, p(0, 1), 1)).toBe(1)
    expect(matchIndexFrom(matches, p(0, 3), 1)).toBe(1)
    expect(matchIndexFrom(matches, p(1, 1), 1)).toBe(0)
  })
  it('finds the previous match before a position, wrapping to the last', () => {
    expect(matchIndexFrom(matches, p(0, 3), -1)).toBe(0)
    expect(matchIndexFrom(matches, p(0, 0), -1)).toBe(2)
  })
  it('returns -1 when there are no matches', () => {
    expect(matchIndexFrom([], p(0, 0), 1)).toBe(-1)
  })
})

describe('replace', () => {
  it('builds regex replacements with capture groups', () => {
    expect(replacementFor('get_user', 'get_(\\w+)', 'fetch_$1', opts({ regex: true }))).toBe('fetch_user')
    expect(replacementFor('a.b', 'a.b', '$1x', opts())).toBe('$1x') // literal in plain mode
  })
  it('replaces all matches as one undo step', () => {
    const b = new TextBuffer('foo = foo + 1\nprint(foo)')
    const h = new History(b)
    const { matches } = findMatches(b.getLines(), 'foo', opts({ wholeWord: true }))
    const n = h.transact('other', p(0, 0), () => replaceAll(b, matches, 'bar', 'foo', opts({ wholeWord: true })))
    expect(b.getText()).toBe('bar = bar + 1\nprint(bar)')
    expect(n).toEqual(p(0, 0))
    h.undo()
    expect(b.getText()).toBe('foo = foo + 1\nprint(foo)')
  })
})
