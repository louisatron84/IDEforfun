import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import {
  dedentLines,
  deleteSelection,
  indentLines,
  isEmpty,
  selectionRange,
  wordAt,
  wordLeft,
  wordRight
} from './selection'

const p = (line: number, col: number) => ({ line, col })
const sel = (a: [number, number], h: [number, number]) => ({ anchor: p(...a), head: p(...h) })

describe('selection basics', () => {
  it('orders a backwards selection into start/end', () => {
    expect(selectionRange(sel([2, 1], [0, 3]))).toEqual({ start: p(0, 3), end: p(2, 1) })
  })
  it('knows when it is empty', () => {
    expect(isEmpty(sel([1, 1], [1, 1]))).toBe(true)
    expect(isEmpty(sel([1, 1], [1, 2]))).toBe(false)
  })
  it('deletes the selected text and returns the start', () => {
    const b = new TextBuffer('hello\nworld')
    expect(deleteSelection(b, sel([1, 2], [0, 2]))).toEqual(p(0, 2))
    expect(b.getText()).toBe('herld')
  })
})

describe('wordAt (double-click)', () => {
  const line = 'x = my_var.attr  + 1'
  it('selects identifier characters, including underscores and digits', () => {
    expect(wordAt(line, 6)).toEqual([4, 10]) // my_var
    expect(wordAt(line, 10)).toEqual([4, 10]) // just after the word still selects it
  })
  it('selects a run of spaces', () => {
    expect(wordAt(line, 16)).toEqual([15, 17])
  })
  it('selects a single punctuation character', () => {
    expect(wordAt(line, 2)).toEqual([2, 3]) // "="
  })
  it('handles empty lines', () => {
    expect(wordAt('', 0)).toEqual([0, 0])
  })
})

describe('word movement (Ctrl+arrows)', () => {
  const b = new TextBuffer('foo.bar(baz)  qux\nnext')
  it('moves right over a word, then over punctuation', () => {
    expect(wordRight(b, p(0, 0))).toEqual(p(0, 3))
    expect(wordRight(b, p(0, 3))).toEqual(p(0, 4)) // "."
    expect(wordRight(b, p(0, 12))).toEqual(p(0, 17)) // skips spaces, then "qux"
  })
  it('wraps to the next/previous line at the edges', () => {
    expect(wordRight(b, p(0, 17))).toEqual(p(1, 0))
    expect(wordLeft(b, p(1, 0))).toEqual(p(0, 17))
  })
  it('moves left to the start of the word', () => {
    expect(wordLeft(b, p(0, 17))).toEqual(p(0, 14))
    expect(wordLeft(b, p(0, 14))).toEqual(p(0, 11)) // skips spaces, then ")"
    expect(wordLeft(b, p(0, 6))).toEqual(p(0, 4))
  })
})

describe('indent / dedent selected lines (Tab / Shift+Tab)', () => {
  it('indents every selected line and shifts the selection with it', () => {
    const b = new TextBuffer('a\nb\nc')
    const out = indentLines(b, sel([0, 1], [1, 1]), 4)
    expect(b.getLines()).toEqual(['    a', '    b', 'c'])
    expect(out).toEqual(sel([0, 5], [1, 5]))
  })
  it('skips the last line when the selection ends at its column 0', () => {
    const b = new TextBuffer('a\nb\nc')
    indentLines(b, sel([0, 0], [2, 0]), 4)
    expect(b.getLines()).toEqual(['    a', '    b', 'c'])
  })
  it('does not add trailing spaces to empty lines', () => {
    const b = new TextBuffer('a\n\nb')
    indentLines(b, sel([0, 0], [2, 1]), 4)
    expect(b.getLines()).toEqual(['    a', '', '    b'])
  })
  it('dedents by up to one level, never past column 0', () => {
    const b = new TextBuffer('        a\n  b\nc')
    const out = dedentLines(b, sel([0, 9], [2, 1]), 4)
    expect(b.getLines()).toEqual(['    a', 'b', 'c'])
    expect(out).toEqual(sel([0, 5], [2, 1]))
  })
  it('dedents a leading tab character', () => {
    const b = new TextBuffer('\tx')
    dedentLines(b, sel([0, 1], [0, 1]), 4)
    expect(b.getText()).toBe('x')
  })
})
