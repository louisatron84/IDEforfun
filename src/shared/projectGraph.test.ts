import { describe, expect, it } from 'vitest'
import { keepLastGood, replaceFiles, type RawFile, type RawScan } from './projectGraph'

const file = (path: string, over: Partial<RawFile> = {}): RawFile => ({
  path, module: path.replace(/\.py$/, '').replace(/\//g, '.'), isPackage: false, imports: [], routes: [], http: [], env: [], lines: 3,
  defs: [{ name: '<module>', qual: '<module>', kind: 'module', line: 1, endLine: 3, calls: [], refs: [], decorators: [] }], ...over
})
const scan = (...files: RawFile[]): RawScan => ({ root: '/p', python: '3.12', truncated: false, files })
const withFn = (path: string, name: string) => file(path, { defs: [...file(path).defs, { name, qual: name, kind: 'function', line: 1, endLine: 2, calls: [], refs: [], decorators: [] }] })

describe('keepLastGood', () => {
  it('a file with a syntax error keeps its last good functions (and its error)', () => {
    const prev = scan(withFn('a.py', 'total'))
    const next = scan(file('a.py', { defs: [], error: 'SyntaxError: invalid syntax (line 2)' }))
    const merged = keepLastGood(next, prev).files[0]
    expect(merged.defs.map((d) => d.name)).toContain('total')
    expect(merged.error).toMatch(/SyntaxError/)
  })
  it('good files, other errors and new files are as scanned', () => {
    const prev = scan(withFn('a.py', 'old'))
    expect(keepLastGood(scan(withFn('a.py', 'new')), prev).files[0].defs.map((d) => d.name)).toContain('new')
    expect(keepLastGood(scan(file('a.py', { defs: [], error: 'too large to analyse' })), prev).files[0].defs).toEqual([])
    expect(keepLastGood(scan(file('b.py')), null).files.map((f) => f.path)).toEqual(['b.py'])
  })
})

describe('replaceFiles', () => {
  it('swaps in the rescanned files and adds new ones', () => {
    const s = replaceFiles(scan(withFn('a.py', 'x'), file('b.py')), [withFn('a.py', 'renamed'), file('c.py')])
    expect(s.files.map((f) => f.path)).toEqual(['a.py', 'b.py', 'c.py'])
    expect(s.files[0].defs.map((d) => d.name)).toContain('renamed')
  })
})
