import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import { History } from './history'

const p = (line: number, col: number) => ({ line, col })

/** A buffer wired to a history, plus a fake clock we can move forward. */
function setup(text: string) {
  const buffer = new TextBuffer(text)
  let now = 0
  const history = new History(buffer, { now: () => now })
  return { buffer, history, tick: (ms: number) => (now += ms) }
}

describe('History', () => {
  it('undoes and redoes a single insert, returning cursor positions', () => {
    const { buffer, history } = setup('ab')
    history.transact('paste', p(0, 1), () => buffer.insert(p(0, 1), 'X\nY'))
    expect(buffer.getText()).toBe('aX\nYb')

    expect(history.undo()).toEqual(p(0, 1))
    expect(buffer.getText()).toBe('ab')
    expect(history.redo()).toEqual(p(1, 1))
    expect(buffer.getText()).toBe('aX\nYb')
  })

  it('undoes a multi-line delete', () => {
    const { buffer, history } = setup('ab\ncd\nef')
    history.transact('delete', p(2, 1), () => {
      buffer.delete(p(0, 1), p(2, 1))
      return p(0, 1)
    })
    expect(buffer.getText()).toBe('af')
    history.undo()
    expect(buffer.getText()).toBe('ab\ncd\nef')
  })

  it('keeps typing in one step when a keystroke only steps over an auto-closed bracket', () => {
    const { buffer, history, tick } = setup('')
    // "g(" inserts "g()" with the cursor between; ")" steps over; ":" continues.
    let pos = history.transact('typing', p(0, 0), () => buffer.insert(p(0, 0), 'g'))
    tick(50)
    pos = history.transact('typing', pos, () => {
      buffer.insert(pos, '()')
      return p(0, 2)
    })
    tick(50)
    pos = history.transact('typing', pos, () => p(0, 3)) // step over ")": no change
    tick(50)
    history.transact('typing', pos, () => buffer.insert(pos, ':'))
    expect(buffer.getText()).toBe('g():')
    history.undo()
    expect(buffer.getText()).toBe('')
  })

  it('groups quick consecutive typing into one undo step', () => {
    const { buffer, history, tick } = setup('')
    let pos = p(0, 0)
    for (const ch of 'hello') {
      pos = history.transact('typing', pos, () => buffer.insert(pos, ch))
      tick(100)
    }
    history.undo()
    expect(buffer.getText()).toBe('')
  })

  it('starts a new step after a pause, a cursor jump, or a different kind of edit', () => {
    const { buffer, history, tick } = setup('')
    let pos = p(0, 0)
    pos = history.transact('typing', pos, () => buffer.insert(pos, 'a'))
    tick(2000) // pause
    pos = history.transact('typing', pos, () => buffer.insert(pos, 'b'))
    pos = history.transact('newline', pos, () => buffer.insert(pos, '\n'))
    pos = history.transact('typing', pos, () => buffer.insert(pos, 'c'))
    history.transact('typing', p(0, 0), () => buffer.insert(p(0, 0), 'Z')) // cursor jumped

    expect(buffer.getText()).toBe('Zab\nc')
    history.undo(); expect(buffer.getText()).toBe('ab\nc')
    history.undo(); expect(buffer.getText()).toBe('ab\n')
    history.undo(); expect(buffer.getText()).toBe('ab')
    history.undo(); expect(buffer.getText()).toBe('a')
    history.undo(); expect(buffer.getText()).toBe('')
    expect(history.undo()).toBeNull() // nothing left
  })

  it('a new edit after undo clears the redo stack', () => {
    const { buffer, history } = setup('')
    history.transact('paste', p(0, 0), () => buffer.insert(p(0, 0), 'a'))
    history.undo()
    history.transact('paste', p(0, 0), () => buffer.insert(p(0, 0), 'b'))
    expect(history.redo()).toBeNull()
    expect(buffer.getText()).toBe('b')
  })

  it('tracks dirty state relative to the last save, including after undo', () => {
    const { buffer, history } = setup('')
    expect(history.isDirty()).toBe(false)
    let pos = history.transact('typing', p(0, 0), () => buffer.insert(p(0, 0), 'a'))
    expect(history.isDirty()).toBe(true)
    history.markSaved()
    expect(history.isDirty()).toBe(false)

    // Typing right after saving must not merge into the saved step.
    pos = history.transact('typing', pos, () => buffer.insert(pos, 'b'))
    expect(history.isDirty()).toBe(true)
    history.undo()
    expect(buffer.getText()).toBe('a')
    expect(history.isDirty()).toBe(false) // back to what's on disk
    history.undo()
    expect(history.isDirty()).toBe(true) // now older than what's on disk
  })

  it('typing right after an undo does not merge into the older step', () => {
    const { buffer, history } = setup('')
    let pos = history.transact('typing', p(0, 0), () => buffer.insert(p(0, 0), 'abc'))
    pos = history.transact('newline', pos, () => buffer.insert(pos, '\n'))
    pos = history.undo()! // back to "abc", cursor at (0,3) = where "abc" ended
    history.transact('typing', pos, () => buffer.insert(pos, 'Q'))
    expect(buffer.getText()).toBe('abcQ')
    history.undo()
    expect(buffer.getText()).toBe('abc') // only Q removed, abc survives
  })

  it('ignores transactions that change nothing', () => {
    const { buffer, history } = setup('a')
    history.transact('delete', p(0, 0), () => p(0, 0)) // e.g. Backspace at file start
    expect(history.undo()).toBeNull()
    expect(buffer.getText()).toBe('a')
  })
})
