// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildGraph, type RawFile } from '../../shared/projectGraph'
import { WhereView } from './whereView'
import { InFileView } from './inFileView'

const top = { name: '<module>', qual: '<module>', kind: 'module' as const, line: 1, endLine: 9, calls: [], refs: [], decorators: [] }
const file = (path: string, module: string, extra: Partial<RawFile> = {}): RawFile => ({
  path, module, isPackage: false, imports: [], routes: [], http: [], env: [], lines: 9, defs: [top], ...extra
})
const graph = buildGraph({ root: '/p', python: '3.12', truncated: false, files: [
  file('a.py', 'a', { imports: [{ module: 'b', names: [], alias: null, level: 0, line: 1 }],
    defs: [top, { name: 'go', qual: 'go', kind: 'function', line: 2, endLine: 3, calls: [{ name: 'b.run', line: 3 }], refs: ['b', 'run'], decorators: [] }] }),
  file('b.py', 'b', { defs: [top, { name: 'run', qual: 'run', kind: 'function', line: 1, endLine: 2, calls: [], refs: [], decorators: [] }] })
] })

describe('Where you are view', () => {
  it('draws the module with its neighbours; clicking opens, double-click reveals', () => {
    const hooks = { open: vi.fn(), reveal: vi.fn() }
    const v = new WhereView(hooks)
    v.set(graph, 'a', '')
    expect(v.body.querySelectorAll('.where-node').length).toBe(2)
    expect(v.body.querySelector('.where-node.k-me text')!.textContent).toBe('a')
    const b = v.body.querySelector('.where-node.k-out') as SVGGElement
    b.dispatchEvent(new MouseEvent('click'))
    b.dispatchEvent(new MouseEvent('dblclick'))
    expect(hooks.open).toHaveBeenCalledWith('b')
    expect(hooks.reveal).toHaveBeenCalledWith('b')
  })
  it('shows the message when there is nothing to draw', () => {
    const v = new WhereView({ open: vi.fn(), reveal: vi.fn() })
    v.set(null, null, 'Open a Python file')
    expect(v.body.textContent).toContain('Open a Python file')
  })
})

describe('In this file view', () => {
  it('lists functions with their summary; click jumps to the line', () => {
    const goTo = vi.fn()
    const v = new InFileView(goTo)
    v.set(graph, 'a', '')
    const row = v.body.querySelector('.infile-item') as HTMLElement
    expect(row.textContent).toContain('go')
    expect(row.textContent).toContain('→ b')
    row.click()
    expect(goTo).toHaveBeenCalledWith(1)
  })
})
