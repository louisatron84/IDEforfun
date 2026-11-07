import { describe, expect, it } from 'vitest'
import { formatMs, heatLevel, parseProf, slowest, timePath, viewTimes } from './profile'

const msg = {
  t: 'prof',
  fns: [
    ['module:app', 1, 100, 5],
    ['app:main', 1, 95, 5],
    ['app:load', 2, 80, 10],
    ['util.text:parse', 40, 70, 70],
    ['bad', 'x', 1, 1]
  ],
  edges: [
    ['module:app', 'app:main', 95],
    ['app:main', 'app:load', 80],
    ['app:main', 'util.text:parse', 10],
    ['app:load', 'util.text:parse', 60],
    ['app:load']
  ]
}

describe('run profile', () => {
  it('reads the tracer message and drops malformed rows', () => {
    const p = parseProf(msg)!
    expect(p.fns.size).toBe(4)
    expect(p.fns.get('util.text:parse')).toEqual({ calls: 40, totalMs: 70, selfMs: 70 })
    expect(p.edges.get('app:load→util.text:parse')).toBe(60)
    expect(p.edges.size).toBe(4)
    expect(parseProf({ t: 'tick', at: null, calls: [] })).toBeNull()
    expect(parseProf(null)).toBeNull()
  })

  it('in the Calls view, times are per function; in the Modules view, the time spent in each file', () => {
    const p = parseProf(msg)!
    expect(viewTimes(p, 'calls').get('app:load')).toEqual({ calls: 2, totalMs: 80, selfMs: 10 })
    const mods = viewTimes(p, 'modules')
    expect(mods.get('app')).toEqual({ calls: 4, totalMs: 20, selfMs: 20 })
    expect(mods.get('util.text')).toEqual({ calls: 40, totalMs: 70, selfMs: 70 })
  })

  it('heats the functions that take the most of the time', () => {
    expect(heatLevel(60, 100)).toBe(3)
    expect(heatLevel(30, 100)).toBe(2)
    expect(heatLevel(6, 100)).toBe(1)
    expect(heatLevel(2, 100)).toBe(0)
    // Too quick to matter, however it compares.
    expect(heatLevel(0.5, 0.6)).toBe(0)
  })

  it('explains where the time comes from: the heaviest callers, from the start of the program', () => {
    const p = parseProf(msg)!
    expect(timePath(p, 'util.text:parse')).toEqual(['module:app', 'app:main', 'app:load', 'util.text:parse'])
    expect(timePath(p, 'module:app')).toEqual(['module:app'])
  })

  it('stops at a loop of callers', () => {
    const p = parseProf({ t: 'prof', fns: [['m:a', 1, 5, 1], ['m:b', 1, 5, 1]], edges: [['m:a', 'm:b', 5], ['m:b', 'm:a', 4]] })!
    expect(timePath(p, 'm:b')).toEqual(['m:a', 'm:b'])
  })

  it('lists the slowest functions by their own time', () => {
    const p = parseProf(msg)!
    expect(slowest(p, 2).map((s) => s.id)).toEqual(['util.text:parse', 'app:load'])
  })

  it('formats times for people', () => {
    expect(formatMs(0.04)).toBe('<0.1 ms')
    expect(formatMs(0.42)).toBe('0.4 ms')
    expect(formatMs(12.3)).toBe('12 ms')
    expect(formatMs(1534)).toBe('1.5 s')
  })
})
