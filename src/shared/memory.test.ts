import { describe, expect, it } from 'vitest'
import { formatBytes, MemoryLog, parseMem } from './memory'

describe('memory messages', () => {
  it('reads a tracer message and drops malformed parts', () => {
    const m = parseMem({
      t: 'mem', peak: 5000, samples: [[0.1, 1000], [0.2, 'x'], [0.3, 3000]],
      sites: [['app.py', 6, 4000, 20], ['bad']], types: [['app.Item', 20], [3, 4]],
      final: true, kept: [{ type: 'app.Item', count: 20, path: ['app.CACHE', 'list'] }, { type: 1 }]
    })!
    expect(m.samples).toEqual([[0.1, 1000], [0.3, 3000]])
    expect(m.sites).toEqual([{ path: 'app.py', line: 6, bytes: 4000, count: 20 }])
    expect(m.types).toEqual([['app.Item', 20]])
    expect(m.kept).toEqual([{ type: 'app.Item', count: 20, path: ['app.CACHE', 'list'] }])
    expect(m.final).toBe(true)
    expect(parseMem({ t: 'tick' })).toBeNull()
  })
})

describe('MemoryLog', () => {
  it('collects a run: use over time, the latest sites, each class\'s counts over time', () => {
    const log = new MemoryLog()
    log.begin(7)
    log.add(parseMem({ t: 'mem', peak: 2000, samples: [[0.1, 1000]], sites: [['a.py', 1, 900, 3]], types: [['a.Item', 10]] })!)
    log.add(parseMem({ t: 'mem', peak: 6000, samples: [[0.6, 5000]] })!)
    log.add(parseMem({ t: 'mem', peak: 9000, samples: [[2.1, 8000]], sites: [['a.py', 2, 7000, 9]], types: [['a.Item', 40], ['a.Node', 3]] })!)
    expect(log.samples).toEqual([[0.1, 1000], [0.6, 5000], [2.1, 8000]])
    expect(log.peak).toBe(9000)
    expect(log.sites[0].line).toBe(2)
    expect(log.types.get('a.Item')).toEqual([[0.1, 10], [2.1, 40]])
    expect(log.types.get('a.Node')).toEqual([[2.1, 3]])
    expect(log.running).toBe(true)
    log.add(parseMem({ t: 'mem', peak: 9000, samples: [], final: true, kept: [] })!)
    expect(log.running).toBe(false)
    log.begin(8)
    expect(log.samples).toEqual([])
  })

  it('says which classes keep growing', () => {
    const log = new MemoryLog()
    log.begin(1)
    for (const [t, item, node] of [[1, 10, 5], [3, 40, 6], [5, 90, 5], [7, 160, 5]]) {
      log.add(parseMem({ t: 'mem', peak: 1, samples: [[t, 1]], types: [['a.Item', item], ['a.Node', node]] })!)
    }
    expect(log.growing('a.Item')).toBe(true)
    expect(log.growing('a.Node')).toBe(false)
  })
})

describe('formatBytes', () => {
  it('in units people read', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
  })
})
