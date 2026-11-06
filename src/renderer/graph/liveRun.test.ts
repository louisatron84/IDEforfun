import { describe, expect, it } from 'vitest'
import { newApiBox } from '../../shared/boxes'
import { parseTrace, planFrame, type RunView } from './liveRun'

describe('parseTrace', () => {
  it('ticks, end, and junk', () => {
    expect(parseTrace({ t: 'tick', at: 'a:f', calls: [['a:f', 'b:g', 3]] })).toEqual({ at: 'a:f', calls: [['a:f', 'b:g', 3]] })
    expect(parseTrace({ t: 'tick', at: null, calls: [] })).toEqual({ at: null, calls: [] })
    expect(parseTrace({ t: 'end' })).toBe('end')
    expect(parseTrace({ t: 'hello', token: 'x' })).toBeNull()
    expect(parseTrace({ t: 'tick', at: 5, calls: [] })).toBeNull()
    expect(parseTrace(null)).toBeNull()
    // bad call rows are dropped, not fatal
    expect(parseTrace({ t: 'tick', at: 'a:f', calls: [['a:f', 'b:g', -1], ['x'], ['a:f', 'c:h', 2]] })).toEqual({ at: 'a:f', calls: [['a:f', 'c:h', 2]] })
  })
})

const calls: RunView = {
  mode: 'calls',
  nodes: new Set(['module:main', 'main:start', 'pkg.b:work']),
  edges: new Set(['module:main→main:start', 'main:start→pkg.b:work'])
}
const modules: RunView = {
  mode: 'modules',
  nodes: new Set(['main', 'pkg.b']),
  edges: new Set(['main→pkg.b'])
}

describe('planFrame', () => {
  it('calls view: the running function glows, sparks on shown edges only', () => {
    const plan = planFrame({ at: 'pkg.b:work', calls: [['main:start', 'pkg.b:work', 5], ['main:start', 'hidden:x', 9], ['module:main', 'main:start', 1]] }, calls, [])
    expect(plan.glow).toBe('pkg.b:work')
    expect(plan.sparks).toEqual([{ from: 'main:start', to: 'pkg.b:work' }, { from: 'module:main', to: 'main:start' }])
  })

  it('modules view: modules glow; calls between modules spark along the import line, callee direction', () => {
    const plan = planFrame({ at: 'pkg.b:work', calls: [['main:start', 'pkg.b:work', 5], ['pkg.b:work', 'main:start', 1], ['main:start', 'module:main', 2]] }, modules, [])
    expect(plan.glow).toBe('pkg.b')
    expect(plan.sparks).toEqual([{ from: 'main', to: 'pkg.b' }, { from: 'pkg.b', to: 'main' }])
  })

  it('module-level code maps to its module; nothing shown means no glow', () => {
    expect(planFrame({ at: 'module:main', calls: [] }, modules, []).glow).toBe('main')
    expect(planFrame({ at: 'other:f', calls: [] }, modules, []).glow).toBeNull()
    expect(planFrame({ at: null, calls: [] }, calls, []).glow).toBeNull()
  })

  it('at most 12 sparks, busiest first', () => {
    const edges = new Set<string>()
    const many: RunView = { mode: 'calls', nodes: new Set(), edges }
    const rows: [string, string, number][] = []
    for (let i = 0; i < 20; i++) {
      edges.add(`a:f→b:g${i}`)
      rows.push(['a:f', `b:g${i}`, i + 1])
    }
    const plan = planFrame({ at: null, calls: rows }, many, [])
    expect(plan.sparks).toHaveLength(12)
    expect(plan.sparks[0]).toEqual({ from: 'a:f', to: 'b:g19' })
  })

  it('a box glows while its function runs, or is called', () => {
    const box = newApiBox([], 'GitHub')
    box.attach = { module: 'app.api' }
    box.requests[0].name = 'users'
    expect(planFrame({ at: 'app.api:github_users', calls: [] }, calls, [box]).boxes).toEqual([box.id])
    expect(planFrame({ at: 'main:start', calls: [['main:start', 'app.api:github_users', 1]] }, calls, [box]).boxes).toEqual([box.id])
    expect(planFrame({ at: 'main:start', calls: [] }, calls, [box]).boxes).toEqual([])
  })
})
