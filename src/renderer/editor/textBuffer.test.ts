import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'

describe('TextBuffer', () => {
  it('round-trips text and keeps the original line ending style', () => {
    expect(new TextBuffer('a\nb').getText()).toBe('a\nb')
    expect(new TextBuffer('a\r\nb\r\n').getText()).toBe('a\r\nb\r\n')
    expect(new TextBuffer('').lineCount).toBe(1)
  })

  it('inserts text inside a line and returns the position after it', () => {
    const b = new TextBuffer('helo')
    const end = b.insert({ line: 0, col: 3 }, 'l')
    expect(b.getText()).toBe('hello')
    expect(end).toEqual({ line: 0, col: 4 })
  })

  it('inserts multi-line text (e.g. a paste)', () => {
    const b = new TextBuffer('start end')
    const end = b.insert({ line: 0, col: 6 }, 'one\ntwo\r\nthree ')
    expect(b.getLines()).toEqual(['start one', 'two', 'three end'])
    expect(end).toEqual({ line: 2, col: 6 })
  })

  it('deletes within a line', () => {
    const b = new TextBuffer('hello')
    b.delete({ line: 0, col: 1 }, { line: 0, col: 3 })
    expect(b.getText()).toBe('hlo')
  })

  it('deletes across lines, joining them, and accepts reversed ranges', () => {
    const b = new TextBuffer('ab\ncd\nef')
    b.delete({ line: 2, col: 1 }, { line: 0, col: 1 })
    expect(b.getText()).toBe('af')
  })

  it('converts between positions and offsets', () => {
    const b = new TextBuffer('ab\ncde\nf')
    expect(b.offsetAt({ line: 1, col: 2 })).toBe(5)
    expect(b.positionAt(5)).toEqual({ line: 1, col: 2 })
    expect(b.positionAt(3)).toEqual({ line: 1, col: 0 })
    expect(b.positionAt(999)).toEqual({ line: 2, col: 1 })
  })

  it('clamps out-of-range positions', () => {
    const b = new TextBuffer('ab\ncde')
    expect(b.clamp({ line: 9, col: 9 })).toEqual({ line: 1, col: 3 })
    expect(b.clamp({ line: -1, col: -5 })).toEqual({ line: 0, col: 0 })
  })
})
