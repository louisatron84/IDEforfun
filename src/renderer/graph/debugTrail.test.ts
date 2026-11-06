import { describe, expect, it } from 'vitest'
import { DebugTrail, diffVars, frameNode, type FrameLike } from './debugTrail'
import type { ProjectGraph } from '../../shared/projectGraph'

const graph = {
  modules: [
    {
      id: 'app.service', path: 'app/service.py', symbols: [
        { id: 'app.service:Client', module: 'app.service', qual: 'Client', name: 'Client', kind: 'class', line: 3, endLine: 12, decorators: [] },
        { id: 'app.service:Client.get', module: 'app.service', qual: 'Client.get', name: 'get', kind: 'method', line: 5, endLine: 8, decorators: [] },
        { id: 'app.service:fetch', module: 'app.service', qual: 'fetch', name: 'fetch', kind: 'function', line: 14, endLine: 20, decorators: [] }
      ]
    },
    { id: 'main', path: 'main.py', symbols: [] },
    { id: 'pkg', path: 'pkg/__init__.py', symbols: [] }
  ]
} as unknown as ProjectGraph

const f = (path: string | null, line1: number): FrameLike => ({ path, line: line1 - 1 })

describe('frameNode', () => {
  it('finds the innermost function or method around the line', () => {
    expect(frameNode(f('C:\\proj\\app\\service.py', 6), graph, 'C:\\proj')).toBe('app.service:Client.get')
    expect(frameNode(f('C:\\proj\\app\\service.py', 10), graph, 'C:\\proj')).toBe('app.service:Client')
    expect(frameNode(f('C:/proj/app/service.py', 15), graph, 'C:/proj/')).toBe('app.service:fetch')
  })
  it('top-level code is the module; a package is its __init__', () => {
    expect(frameNode(f('/p/main.py', 1), graph, '/p')).toBe('module:main')
    expect(frameNode(f('/p/pkg/__init__.py', 1), graph, '/p')).toBe('module:pkg')
  })
  it('matches paths case-insensitively on Windows-style paths', () => {
    expect(frameNode(f('c:\\PROJ\\App\\Service.py', 15), graph, 'C:\\proj')).toBe('app.service:fetch')
  })
  it('nothing for files outside the project or unknown', () => {
    expect(frameNode(f('C:\\Python\\lib\\json\\__init__.py', 1), graph, 'C:\\proj')).toBeNull()
    expect(frameNode(f(null, 1), graph, 'C:\\proj')).toBeNull()
    expect(frameNode(f('C:\\proj\\other.py', 1), graph, 'C:\\proj')).toBeNull()
  })
})

describe('diffVars', () => {
  it('lists what was added, removed and changed', () => {
    expect(diffVars({ a: '1', b: '2', c: '3' }, { a: '1', b: '5', d: '4' })).toEqual({
      added: ['d'], removed: ['c'], changed: ['b'], same: ['a']
    })
  })
})

describe('DebugTrail', () => {
  it('records each pause, the calls seen on the stack, and new calls since the last pause', () => {
    const t = new DebugTrail()
    const first = t.addStop({ reason: 'breakpoint', stack: ['app.service:fetch', 'module:main'], vars: { url: "'x'" } })
    expect(first.n).toBe(1)
    expect(first.newEdges).toEqual([['module:main', 'app.service:fetch']])
    const second = t.addStop({ reason: 'step', stack: ['app.service:Client.get', 'app.service:fetch', 'module:main'], vars: { self: '<Client>' } })
    expect(second.newEdges).toEqual([['app.service:fetch', 'app.service:Client.get']])
    expect(t.edges()).toEqual([['module:main', 'app.service:fetch', 2], ['app.service:fetch', 'app.service:Client.get', 1]])
  })

  it('stack entries outside the project are skipped (their callers link to the next project frame)', () => {
    const t = new DebugTrail()
    t.addStop({ reason: 'step', stack: ['a:f', null, 'module:a'], vars: {} })
    expect(t.edges()).toEqual([['module:a', 'a:f', 1]])
  })

  it('history: the values of a function\'s variables at each pause in it, marking changes', () => {
    const t = new DebugTrail()
    t.addStop({ reason: 'breakpoint', stack: ['a:f'], vars: { i: '0', total: '0' } })
    t.addStop({ reason: 'step', stack: ['a:g', 'a:f'], vars: { x: '1' } })
    t.addStop({ reason: 'step', stack: ['a:f'], vars: { i: '1', total: '0', last: '3' } })
    const h = t.history('a:f')
    expect(h.stops).toEqual([1, 3])
    expect(h.rows).toEqual([
      { name: 'i', values: ['0', '1'], changed: [false, true] },
      { name: 'total', values: ['0', '0'], changed: [false, false] },
      { name: 'last', values: [null, '3'], changed: [false, true] }
    ])
    expect(t.history('a:none')).toEqual({ stops: [], rows: [] })
  })

  it('keeps at most 200 pauses', () => {
    const t = new DebugTrail()
    for (let i = 0; i < 250; i++) t.addStop({ reason: 'step', stack: ['a:f'], vars: { i: String(i) } })
    expect(t.stops.length).toBe(200)
    expect(t.stops[0].n).toBe(51)
    expect(t.stop(250)?.vars.i).toBe('249')
  })
})
