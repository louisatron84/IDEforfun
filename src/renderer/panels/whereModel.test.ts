import { describe, expect, it } from 'vitest'
import { buildGraph, type RawFile, type RawScan } from '../../shared/projectGraph'
import { fileSummary, moduleForPath, neighbourhood } from './whereModel'

const file = (path: string, module: string, extra: Partial<RawFile> = {}): RawFile => ({
  path, module, isPackage: path.endsWith('__init__.py'), imports: [], routes: [], http: [], env: [], lines: 10,
  defs: [{ name: '<module>', qual: '<module>', kind: 'module', line: 1, endLine: 10, calls: [], refs: [], decorators: [] }],
  ...extra
})
const fn = (qual: string, line: number, calls: string[] = []) => ({
  name: qual.split('.').pop()!, qual, kind: 'function' as const, line, endLine: line + 2,
  calls: calls.map((name) => ({ name, line: line + 1 })), refs: calls, decorators: []
})
const top = file('', '').defs[0]

const graph = buildGraph({
  root: '/p', python: '3.12', truncated: false,
  files: [
    file('pkg/__init__.py', 'pkg', { lines: 1 }),
    file('pkg/a.py', 'pkg.a', {
      imports: [{ module: 'pkg.b', names: ['run'], alias: null, level: 0, line: 1 }, { module: 'requests', names: [], alias: null, level: 0, line: 2 }],
      defs: [top, fn('start', 3, ['run', 'helper']), fn('helper', 7)],
      http: [{ library: 'requests', method: 'GET', url: 'https://api.x.com/v1', line: 4, func: 'start' }]
    }),
    file('pkg/b.py', 'pkg.b', { defs: [top, fn('run', 1)] }),
    file('tests/test_a.py', 'tests.test_a', {
      imports: [{ module: 'pkg.a', names: ['start'], alias: null, level: 0, line: 1 }],
      defs: [top, fn('test_start', 2, ['start'])]
    })
  ]
} satisfies RawScan)

describe('Where you are / In this file data', () => {
  it('moduleForPath maps project-relative paths to modules', () => {
    expect(moduleForPath(graph, 'pkg/a.py')).toBe('pkg.a')
    expect(moduleForPath(graph, 'pkg\\a.py')).toBe('pkg.a')
    expect(moduleForPath(graph, 'pkg/__init__.py')).toBe('pkg')
    expect(moduleForPath(graph, 'notes.txt')).toBeNull()
  })

  it('neighbourhood: project imports both ways, and the web APIs it calls', () => {
    expect(neighbourhood(graph, 'pkg.a')).toEqual({ module: 'pkg.a', imports: ['pkg.b'], importedBy: ['tests.test_a'], hosts: ['api.x.com'] })
    expect(neighbourhood(graph, 'pkg.b')).toEqual({ module: 'pkg.b', imports: [], importedBy: ['pkg.a'], hosts: [] })
  })

  it('fileSummary: each function with what it reaches outside its module and who uses it', () => {
    expect(fileSummary(graph, 'pkg.a')).toEqual([
      { qual: 'start', kind: 'function', line: 3, summary: '→ api.x.com, pkg.b · used by tests.test_a' },
      { qual: 'helper', kind: 'function', line: 7, summary: '' }
    ])
    expect(fileSummary(graph, 'pkg.b')[0].summary).toBe('used by pkg.a')
  })
})
