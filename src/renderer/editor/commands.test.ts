import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import {
  backspace,
  colFromVisual,
  deleteForward,
  insertTab,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveVertical,
  newline,
  visualCol
} from './commands'

const p = (line: number, col: number) => ({ line, col })

describe('horizontal movement', () => {
  const b = new TextBuffer('ab\ncd')
  it('wraps to the previous/next line at the edges', () => {
    expect(moveLeft(b, p(1, 0))).toEqual(p(0, 2))
    expect(moveRight(b, p(0, 2))).toEqual(p(1, 0))
  })
  it('stops at the start and end of the file', () => {
    expect(moveLeft(b, p(0, 0))).toEqual(p(0, 0))
    expect(moveRight(b, p(1, 2))).toEqual(p(1, 2))
  })
})

describe('Home / End', () => {
  const b = new TextBuffer('    x = 1')
  it('Home goes to the first non-space, then to column 0', () => {
    expect(moveHome(b, p(0, 9))).toEqual(p(0, 4))
    expect(moveHome(b, p(0, 4))).toEqual(p(0, 0))
  })
  it('End goes to the end of the line', () => {
    expect(moveEnd(b, p(0, 2))).toEqual(p(0, 9))
  })
})

describe('tabs and visual columns', () => {
  it('expands tabs to the next tab stop', () => {
    expect(visualCol('\tx', 1, 4)).toBe(4)
    expect(visualCol('ab\tx', 3, 4)).toBe(4)
    expect(visualCol('abc', 2, 4)).toBe(2)
  })
  it('maps a visual column back to the nearest character column', () => {
    expect(colFromVisual('\tx', 4, 4)).toBe(1)
    expect(colFromVisual('\tx', 1, 4)).toBe(0)
    expect(colFromVisual('\tx', 3, 4)).toBe(1)
    expect(colFromVisual('ab', 10, 4)).toBe(2)
  })
})

describe('vertical movement', () => {
  const b = new TextBuffer('long line\nab\nanother long')
  it('keeps the goal column across short lines', () => {
    const goal = visualCol(b.getLine(0), 7, 4)
    const down1 = moveVertical(b, p(0, 7), 1, goal, 4)
    expect(down1).toEqual(p(1, 2))
    expect(moveVertical(b, down1, 1, goal, 4)).toEqual(p(2, 7))
  })
  it('goes to the line start/end at the top/bottom of the file', () => {
    expect(moveVertical(b, p(0, 4), -1, 4, 4)).toEqual(p(0, 0))
    expect(moveVertical(b, p(2, 3), 1, 3, 4)).toEqual(p(2, 12))
  })
})

describe('Backspace', () => {
  it('deletes one character', () => {
    const b = new TextBuffer('abc')
    expect(backspace(b, p(0, 2), 4)).toEqual(p(0, 1))
    expect(b.getText()).toBe('ac')
  })
  it('joins with the previous line at column 0', () => {
    const b = new TextBuffer('ab\ncd')
    expect(backspace(b, p(1, 0), 4)).toEqual(p(0, 2))
    expect(b.getText()).toBe('abcd')
  })
  it('removes a whole indent level inside leading spaces', () => {
    const b = new TextBuffer('        x')
    expect(backspace(b, p(0, 8), 4)).toEqual(p(0, 4))
    expect(b.getText()).toBe('    x')
  })
  it('snaps uneven indentation back to the previous tab stop', () => {
    const b = new TextBuffer('      x')
    expect(backspace(b, p(0, 6), 4)).toEqual(p(0, 4))
  })
  it('does nothing at the start of the file', () => {
    const b = new TextBuffer('a')
    expect(backspace(b, p(0, 0), 4)).toEqual(p(0, 0))
  })
})

describe('Delete', () => {
  it('deletes the next character, or joins the next line at the end', () => {
    const b = new TextBuffer('ab\ncd')
    deleteForward(b, p(0, 0))
    expect(b.getText()).toBe('b\ncd')
    deleteForward(b, p(0, 1))
    expect(b.getText()).toBe('bcd')
  })
})

describe('Enter (Python auto-indent)', () => {
  it('keeps the current indentation', () => {
    const b = new TextBuffer('    x = 1')
    expect(newline(b, p(0, 9), 4)).toEqual(p(1, 4))
    expect(b.getText()).toBe('    x = 1\n    ')
  })
  it('indents one more level after a colon', () => {
    const b = new TextBuffer('def f():')
    expect(newline(b, p(0, 8), 4)).toEqual(p(1, 4))
    expect(b.getText()).toBe('def f():\n    ')
  })
  it('ignores trailing spaces and comments after the colon', () => {
    const b = new TextBuffer('if x:   # check')
    expect(newline(b, p(0, 15), 4)).toEqual(p(1, 4))
  })
  it('splits a line, moving the rest down without its leading spaces', () => {
    const b = new TextBuffer('    a = 1 + 2')
    newline(b, p(0, 10), 4)
    expect(b.getLines()).toEqual(['    a = 1 ', '    + 2'])
  })
})

describe('Tab', () => {
  it('inserts spaces up to the next tab stop', () => {
    const b = new TextBuffer('ab')
    expect(insertTab(b, p(0, 2), 4)).toEqual(p(0, 4))
    expect(b.getText()).toBe('ab  ')
  })
})
