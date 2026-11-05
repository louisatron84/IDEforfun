import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import { allOccurrences, editAll, mapPosition, nextOccurrence, normalize } from './multiCursor'
import * as cmd from './commands'
import * as sel from './selection'

const P = (line: number, col: number) => ({ line, col })
const C = (line: number, col: number) => ({ anchor: P(line, col), head: P(line, col) })

describe('mapPosition', () => {
  it('moves positions after an insert on the same line', () => {
    expect(mapPosition(P(0, 5), { kind: 'insert', at: P(0, 2), text: 'abc' })).toEqual(P(0, 8))
    expect(mapPosition(P(0, 1), { kind: 'insert', at: P(0, 2), text: 'abc' })).toEqual(P(0, 1))
  })
  it('handles inserted line breaks', () => {
    expect(mapPosition(P(0, 5), { kind: 'insert', at: P(0, 2), text: 'x\nyy' })).toEqual(P(1, 5))
    expect(mapPosition(P(3, 1), { kind: 'insert', at: P(0, 2), text: '\n\n' })).toEqual(P(5, 1))
  })
  it('an insert exactly at the position: after (stickAfter) or in front', () => {
    expect(mapPosition(P(0, 2), { kind: 'insert', at: P(0, 2), text: 'ab' })).toEqual(P(0, 4))
    expect(mapPosition(P(0, 2), { kind: 'insert', at: P(0, 2), text: 'ab' }, false)).toEqual(P(0, 2))
  })
  it('handles deletes: before, inside and after', () => {
    const d = { kind: 'delete' as const, at: P(1, 2), text: 'cd\nef' } // removes (1,2)..(2,2)
    expect(mapPosition(P(1, 1), d)).toEqual(P(1, 1))
    expect(mapPosition(P(2, 0), d)).toEqual(P(1, 2))
    expect(mapPosition(P(2, 5), d)).toEqual(P(1, 5))
    expect(mapPosition(P(4, 3), d)).toEqual(P(3, 3))
  })
})

describe('normalize', () => {
  it('sorts and removes duplicate cursors, keeping the primary flag', () => {
    const out = normalize([{ ...C(2, 0), primary: true }, C(0, 1), C(2, 0)])
    expect(out.map((s) => s.head)).toEqual([P(0, 1), P(2, 0)])
    expect(out[1].primary).toBe(true)
  })
  it('merges overlapping selections', () => {
    const out = normalize([{ anchor: P(0, 0), head: P(0, 5) }, { anchor: P(0, 3), head: P(0, 8) }])
    expect(out).toEqual([{ anchor: P(0, 0), head: P(0, 8), primary: true }])
  })
  it('keeps selections that only touch end-to-start apart', () => {
    const out = normalize([{ anchor: P(0, 0), head: P(0, 3) }, { anchor: P(0, 3), head: P(0, 6) }])
    expect(out.length).toBe(2)
  })
})

describe('editAll', () => {
  it('types at every cursor', () => {
    const b = new TextBuffer('ab\ncd\nef')
    const out = editAll(b, [C(0, 1), C(1, 1), C(2, 1)], (s) => {
      const p = b.insert(s.head, 'XY')
      return { anchor: p, head: p }
    })
    expect(b.getText()).toBe('aXYb\ncXYd\neXYf')
    expect(out.map((s) => s.head)).toEqual([P(0, 3), P(1, 3), P(2, 3)])
  })
  it('two cursors on one line both type in the right spots', () => {
    const b = new TextBuffer('a b c')
    editAll(b, [C(0, 1), C(0, 3)], (s) => {
      const p = b.insert(s.head, '!')
      return { anchor: p, head: p }
    })
    expect(b.getText()).toBe('a! b! c')
  })
  it('Enter at several cursors keeps them lined up', () => {
    const b = new TextBuffer('x = 1\ny = 2')
    const out = editAll(b, [C(0, 5), C(1, 5)], (s) => {
      const p = cmd.newline(b, s.head, 4)
      return { anchor: p, head: p }
    })
    expect(b.getText()).toBe('x = 1\n\ny = 2\n')
    expect(out.map((s) => s.head)).toEqual([P(1, 0), P(3, 0)])
  })
  it('replaces several selections', () => {
    const b = new TextBuffer('foo bar foo')
    editAll(b, [{ anchor: P(0, 0), head: P(0, 3) }, { anchor: P(0, 8), head: P(0, 11) }], (s) => {
      const p = b.insert(sel.deleteSelection(b, s), 'baz')
      return { anchor: p, head: p }
    })
    expect(b.getText()).toBe('baz bar baz')
  })
  it('backspace at cursors that end up merging leaves one cursor', () => {
    const b = new TextBuffer('ab')
    const out = editAll(b, [C(0, 1), C(0, 2)], (s) => {
      const p = cmd.backspace(b, s.head, 4)
      return { anchor: p, head: p }
    })
    expect(b.getText()).toBe('')
    expect(out.length).toBe(1)
  })
})

describe('occurrences', () => {
  const b = new TextBuffer('foo = 1\nfoo += foo\nbar')
  it('finds them all', () => {
    expect(allOccurrences(b, 'foo').map((s) => s.anchor)).toEqual([P(0, 0), P(1, 0), P(1, 7)])
  })
  it('finds multi-line text', () => {
    expect(allOccurrences(b, '1\nfoo')).toEqual([{ anchor: P(0, 6), head: P(1, 3) }])
  })
  it('next occurrence skips taken ones and wraps around', () => {
    const taken = [{ anchor: P(1, 7), head: P(1, 10) }]
    expect(nextOccurrence(b, 'foo', P(1, 3), taken)).toEqual({ anchor: P(0, 0), head: P(0, 3) })
    const all = allOccurrences(b, 'foo')
    expect(nextOccurrence(b, 'foo', P(0, 0), all)).toBeNull()
  })
})
