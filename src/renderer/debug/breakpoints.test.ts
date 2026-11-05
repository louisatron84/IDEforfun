import { describe, expect, it } from 'vitest'
import { BreakpointStore, shiftBreakpoints } from './breakpoints'

const ins = (line: number, col: number, text: string) => ({ kind: 'insert' as const, at: { line, col }, text })
const del = (line: number, col: number, text: string) => ({ kind: 'delete' as const, at: { line, col }, text })

describe('shiftBreakpoints', () => {
  it('ignores edits inside a line', () => {
    expect(shiftBreakpoints([2, 5], ins(2, 3, 'abc'))).toEqual([2, 5])
  })
  it('moves breakpoints below an inserted line down', () => {
    expect(shiftBreakpoints([1, 5], ins(3, 4, '\n    '))).toEqual([1, 6])
  })
  it('Enter at the start of a line takes its breakpoint down with it', () => {
    expect(shiftBreakpoints([3], ins(3, 0, '\n'))).toEqual([4])
  })
  it('Enter at the end of a line keeps its breakpoint', () => {
    expect(shiftBreakpoints([3], ins(3, 10, '\n'))).toEqual([3])
  })
  it('pasting several lines shifts by that many', () => {
    expect(shiftBreakpoints([0, 4], ins(2, 0, 'a\nb\nc\n'))).toEqual([0, 7])
  })
  it('joining lines (Backspace at a line start) moves the breakpoint up onto the joined line', () => {
    expect(shiftBreakpoints([4, 8], del(3, 7, '\n'))).toEqual([3, 7])
  })
  it('deleting a multi-line range moves later breakpoints up', () => {
    expect(shiftBreakpoints([1, 2, 3, 9], del(1, 5, 'x\nyy\nz'))).toEqual([1, 7])
  })
  it('deleting whole lines removes their breakpoints', () => {
    expect(shiftBreakpoints([2, 3, 6], del(2, 0, 'line\n'))).toEqual([2, 5])
  })
})

describe('BreakpointStore', () => {
  it('toggles breakpoints per file (Windows paths ignore case and slashes)', () => {
    const s = new BreakpointStore()
    const changed: string[] = []
    s.subscribe((p) => changed.push(p))
    s.toggle('C:\\p\\a.py', 4)
    s.toggle('c:/p/A.py', 1)
    expect(s.linesFor('C:\\p\\a.py')).toEqual([1, 4])
    s.toggle('C:\\p\\a.py', 4)
    expect(s.linesFor('C:\\p\\a.py')).toEqual([1])
    expect(s.count).toBe(1)
    expect(changed.length).toBe(3)
  })
  it('follows edits', () => {
    const s = new BreakpointStore()
    s.toggle('/p/a.py', 5)
    s.applyChange('/p/a.py', ins(0, 0, '\n\n'))
    expect(s.linesFor('/p/a.py')).toEqual([7])
  })
  it('follows renames and deletes', () => {
    const s = new BreakpointStore()
    s.toggle('/p/pkg/a.py', 1)
    s.toggle('/p/main.py', 2)
    s.pathRenamed('/p/pkg', '/p/lib')
    expect(s.linesFor('/p/lib/a.py')).toEqual([1])
    expect(s.linesFor('/p/pkg/a.py')).toEqual([])
    s.removeUnder('/p/lib')
    expect(s.all().map((f) => f.path)).toEqual(['/p/main.py'])
  })
})
