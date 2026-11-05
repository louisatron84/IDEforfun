import { describe, expect, it } from 'vitest'
import { countLines, lastLines, OutputQueue, skippedNote } from './outputBuffer'

describe('OutputQueue', () => {
  it('merges neighbouring pieces of the same stream, in order', () => {
    const q = new OutputQueue(1000)
    q.push('stdout', 'a\n')
    q.push('stdout', 'b\n')
    q.push('stderr', 'err\n')
    q.push('stdout', 'c\n')
    expect(q.take()).toEqual({
      pieces: [{ stream: 'stdout', text: 'a\nb\n' }, { stream: 'stderr', text: 'err\n' }, { stream: 'stdout', text: 'c\n' }],
      dropped: 0
    })
    expect(q.isEmpty).toBe(true)
  })

  it('keeps only the newest output when too much piles up, counting dropped lines', () => {
    const q = new OutputQueue(100)
    for (let i = 0; i < 1000; i++) q.push('stdout', `line ${String(i).padStart(4, '0')}\n`) // 10 chars each
    expect(q.size).toBeLessThanOrEqual(100)
    const { pieces, dropped } = q.take()
    const text = pieces.map((p) => p.text).join('')
    // Whole lines only, ending with the last one printed.
    expect(text.endsWith('line 0999\n')).toBe(true)
    expect(text.startsWith('line ')).toBe(true)
    expect(dropped + text.split('\n').length - 1).toBe(1000)
  })

  it('drops older pieces of another stream too', () => {
    const q = new OutputQueue(20)
    q.push('stderr', 'old error\n')
    q.push('stdout', 'x'.repeat(9) + '\n' + 'y'.repeat(9) + '\n')
    const { pieces, dropped } = q.take()
    expect(pieces).toEqual([{ stream: 'stdout', text: 'y'.repeat(9) + '\n' }])
    expect(dropped).toBe(2)
  })

  it('clear forgets everything', () => {
    const q = new OutputQueue(10)
    q.push('stdout', 'a'.repeat(50))
    q.clear()
    expect(q.take()).toEqual({ pieces: [], dropped: 0 })
  })
})

describe('skippedNote', () => {
  it('says how many lines', () => {
    expect(skippedNote(12345)).toContain('12,345 lines')
    expect(skippedNote(1)).toContain('1 line of')
  })
})

describe('lastLines', () => {
  it('keeps the last lines and says how many were cut', () => {
    expect(lastLines('a\nb\nc\n', 2)).toEqual({ text: 'b\nc\n', cut: 1 })
    expect(lastLines('a\nb\nc\npartial', 2)).toEqual({ text: 'c\npartial', cut: 2 })
    expect(lastLines('a\nb\n', 5)).toEqual({ text: 'a\nb\n', cut: 0 })
    expect(countLines('x\ny\n')).toBe(2)
  })
})
