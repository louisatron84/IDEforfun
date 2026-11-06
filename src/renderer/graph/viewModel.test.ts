import { describe, expect, it } from 'vitest'
import { buildGraph, type RawFile, type RawScan } from '../../shared/projectGraph'
import { buildView, neighbourhood, type ViewOptions } from './viewModel'

const file = (path: string, module: string, extra: Partial<RawFile> = {}): RawFile => ({
  path, module, isPackage: path.endsWith('__init__.py'), imports: [], routes: [], http: [], env: [], lines: 10,
  defs: [{ name: '<module>', qual: '<module>', kind: 'module', line: 1, endLine: 10, calls: [], refs: [], decorators: [] }],
  ...extra
})
const fn = (qual: string, calls: string[] = [], refs: string[] = []) => ({
  name: qual.split('.').pop()!, qual, kind: (qual.includes('.') ? 'method' : 'function') as 'function' | 'method', line: 3, endLine: 5,
  calls: calls.map((name) => ({ name, line: 4 })), refs: [...refs, ...calls], decorators: []
})

const scan: RawScan = {
  root: '/p', python: '3.12', truncated: false,
  files: [
    file('pkg/__init__.py', 'pkg', { lines: 1 }),
    file('pkg/a.py', 'pkg.a', {
      imports: [{ module: 'pkg.b', names: ['run'], alias: null, level: 0, line: 1 }, { module: 'requests', names: [], alias: null, level: 0, line: 2 }],
      defs: [file('', '').defs[0], fn('start', ['run', 'helper']), fn('helper')],
      http: [{ library: 'requests', method: 'GET', url: 'https://api.x.com/v1', line: 4, func: 'start' }],
      main: true
    }),
    file('pkg/b.py', 'pkg.b', { defs: [file('', '').defs[0], fn('run')] }),
    file('tests/test_a.py', 'tests.test_a', {
      imports: [{ module: 'pkg.a', names: ['start'], alias: null, level: 0, line: 1 }],
      defs: [file('', '').defs[0], fn('test_start', ['start'])]
    })
  ]
}
const g = buildGraph(scan)
const opts = (o: Partial<ViewOptions> = {}): ViewOptions => ({ mode: 'modules', focus: null, showExternal: false, showTests: false, showHosts: false, query: '', ...o })
const ids = (o: Partial<ViewOptions>) => buildView(g, opts(o)).nodes.map((n) => n.id).sort()

describe('Project Graph view model', () => {
  it('modules view: modules and imports; empty packages and tests hidden by default', () => {
    const v = buildView(g, opts())
    expect(v.nodes.map((n) => n.id).sort()).toEqual(['pkg.a', 'pkg.b'])
    expect(v.edges).toEqual([{ from: 'pkg.a', to: 'pkg.b', kind: 'import', cyclic: false }])
    expect(v.nodes.find((n) => n.id === 'pkg.a')).toMatchObject({ entry: true, group: 'pkg' })
    expect(ids({ showTests: true })).toEqual(['pkg.a', 'pkg.b', 'tests.test_a'])
  })

  it('packages used and web APIs called can be shown as extra nodes', () => {
    expect(ids({ showExternal: true, showHosts: true })).toEqual(['ext:requests', 'host:api.x.com', 'pkg.a', 'pkg.b'])
    const v = buildView(g, opts({ showHosts: true }))
    expect(v.edges).toContainEqual({ from: 'pkg.a', to: 'host:api.x.com', kind: 'http' })
    expect(v.nodes.find((n) => n.id === 'host:api.x.com')!.detail).toBe('web API · GET')
  })

  it('calls view of one module: its functions plus what they call and what calls them', () => {
    expect(ids({ mode: 'calls', focus: 'pkg.a' })).toEqual(['pkg.a:helper', 'pkg.a:start', 'pkg.b:run'])
    expect(ids({ mode: 'calls', focus: 'pkg.a', showTests: true })).toContain('tests.test_a:test_start')
    const v = buildView(g, opts({ mode: 'calls', focus: 'pkg.a' }))
    expect(v.nodes.find((n) => n.id === 'pkg.b:run')!.label).toBe('pkg.b.run') // from another module: full name
    expect(v.nodes.find((n) => n.id === 'pkg.a:start')).toMatchObject({ label: 'start', line: 2, module: 'pkg.a' })
  })

  it('search keeps matches and their neighbours', () => {
    const v = buildView(g, opts({ query: 'B' }))
    expect(v.nodes.map((n) => [n.id, !!n.match])).toEqual([['pkg.a', false], ['pkg.b', true]])
    expect(buildView(g, opts({ query: 'zzz' })).note).toMatch(/Nothing matches/)
  })

  it('neighbourhood: what a node uses and what uses it', () => {
    const v = buildView(g, opts({ mode: 'calls', focus: 'pkg.a' }))
    const n = neighbourhood(v.edges, 'pkg.a:start')
    expect([...n.out].sort()).toEqual(['pkg.a:helper', 'pkg.b:run'])
    expect([...neighbourhood(v.edges, 'pkg.b:run').in]).toEqual(['pkg.a:start'])
  })
})
