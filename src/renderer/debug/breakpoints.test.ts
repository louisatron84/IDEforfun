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

describe('breakpoint extras', async () => {
  const { BreakpointStore, breakpointStyle } = await import('./breakpoints')
  it('keeps conditions, hit counts and log messages, and moves them with edits', () => {
    const s = new BreakpointStore()
    s.update('/a.py', 4, { condition: ' x > 1 ' })
    s.update('/a.py', 9, { logMessage: 'x is {x}' })
    s.update('/a.py', 9, { hitCondition: '>= 2' })
    expect(s.get('/a.py', 4)).toEqual({ line: 4, enabled: true, condition: 'x > 1' })
    expect(s.get('/a.py', 9)).toEqual({ line: 9, enabled: true, logMessage: 'x is {x}', hitCondition: '>= 2' })
    // Two lines inserted at the top: both move down, extras intact.
    s.applyChange('/a.py', { kind: 'insert', at: { line: 0, col: 0 }, text: 'a\nb\n' } as never)
    expect(s.breakpointsFor('/a.py').map((b) => [b.line, b.condition ?? b.logMessage])).toEqual([[6, 'x > 1'], [11, 'x is {x}']])
    // Clearing a field removes it.
    s.update('/a.py', 6, { condition: '' })
    expect(s.get('/a.py', 6)).toEqual({ line: 6, enabled: true })
  })
  it('switches breakpoints off and counts only the ones that are on', () => {
    const s = new BreakpointStore()
    s.toggle('/a.py', 1)
    s.toggle('/b.py', 2)
    s.update('/b.py', 2, { enabled: false })
    expect(s.count).toBe(1)
    expect(s.total).toBe(2)
    s.setAllEnabled(false)
    expect(s.count).toBe(0)
    expect(breakpointStyle(s.get('/a.py', 1)!)).toBe('disabled')
  })
  it('saves and loads', () => {
    const s = new BreakpointStore()
    s.update('/a.py', 3, { condition: 'y' })
    s.toggle('/b.py', 0)
    const saved = s.save()
    const t = new BreakpointStore()
    t.load(saved)
    expect(t.save()).toEqual(saved)
    expect(breakpointStyle(t.get('/a.py', 3)!)).toBe('conditional')
  })
})
