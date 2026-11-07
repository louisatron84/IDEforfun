import { describe, expect, it } from 'vitest'
import { parseRec, RecursionStore, treeLayout } from './recursionTree'

const msg = (key: string, func: string, nodes: [number, string, string | null][], total = nodes.length) => ({ t: 'rec', tree: { key, func, nodes, total } })

describe('parseRec', () => {
  it('reads a tracer recursion message', () => {
    expect(parseRec(msg('a:f#1', 'a:f', [[-1, '3', '6'], [0, '2', null]]))).toEqual({
      key: 'a:f#1', func: 'a:f', total: 2, nodes: [{ parent: -1, args: '3', ret: '6' }, { parent: 0, args: '2', ret: null }]
    })
  })
  it('rejects anything malformed, including parents that point forwards', () => {
    expect(parseRec({ t: 'tick' })).toBeNull()
    expect(parseRec(msg('k', 'a:f', []))).toBeNull()
    expect(parseRec(msg('k', 'a:f', [[-1, '1', null], [5, '2', null]]))).toBeNull()
    expect(parseRec(msg('k', 'a:f', [[0, '1', null]]))).toBeNull()
  })
})

describe('treeLayout', () => {
  it('leaves side by side, parents centred over their children, rows by depth', () => {
    const t = parseRec(msg('k', 'a:f', [[-1, 'r', null], [0, 'a', null], [0, 'b', null], [1, 'c', null]]))!
    const l = treeLayout(t)
    expect(l.pos.map((p) => `${p.x}/${p.depth}`)).toEqual(['0.5/0', '0/1', '1/1', '0/2'])
    expect(l.columns).toBe(2)
    expect(l.depth).toBe(3)
  })
})

describe('RecursionStore', () => {
  it('keeps the latest version of each tree for the current run, by function', () => {
    const s = new RecursionStore()
    s.begin(1)
    s.add(parseRec(msg('a:f#1', 'a:f', [[-1, '3', null]]))!)
    s.add(parseRec(msg('a:f#1', 'a:f', [[-1, '3', '6'], [0, '2', '2']]))!)
    s.add(parseRec(msg('a:g#2', 'a:g', [[-1, '1', null]]))!)
    expect(s.forFunc('a:f').map((t) => t.nodes.length)).toEqual([2])
    expect(s.funcs()).toEqual(['a:f', 'a:g'])
    s.begin(2)
    expect(s.funcs()).toEqual([])
  })
})
