import { describe, expect, it } from 'vitest'
import { layoutGraph, type LayoutNode, type Placed } from './layout'

const box = (id: string, width = 80, height = 24): LayoutNode => ({ id, width, height })
const overlaps = (a: Placed, b: Placed) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function noOverlaps(nodes: Map<string, Placed>): boolean {
  const all = [...nodes.values()]
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (overlaps(all[i], all[j])) return false
  return true
}

describe('layoutGraph', () => {
  it('puts what a node points to in a column to its right', () => {
    const { nodes } = layoutGraph([box('main'), box('service'), box('util'), box('db')], [
      { from: 'main', to: 'service' }, { from: 'service', to: 'util' }, { from: 'main', to: 'util' }, { from: 'service', to: 'db' }
    ])
    const L = (id: string) => nodes.get(id)!.layer
    expect(L('main')).toBe(0)
    expect(L('service')).toBe(1)
    expect(L('util')).toBe(2) // longest path, not the direct edge
    expect(L('db')).toBe(2)
    expect(nodes.get('util')!.x).toBeGreaterThan(nodes.get('service')!.x)
    expect(noOverlaps(nodes)).toBe(true)
  })

  it('handles loops (import cycles) without hanging, still placing every node', () => {
    const { nodes } = layoutGraph([box('a'), box('b'), box('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }])
    expect([...nodes.keys()].sort()).toEqual(['a', 'b', 'c'])
    expect(new Set([...nodes.values()].map((p) => p.layer)).size).toBe(3)
  })

  it('reduces crossings: children follow the order of their parents', () => {
    const { nodes } = layoutGraph([box('p1'), box('p2'), box('c2'), box('c1')], [{ from: 'p1', to: 'c1' }, { from: 'p2', to: 'c2' }, { from: 'r', to: 'p1' }, { from: 'r', to: 'p2' }].map((e) => e), {})
    // ('r' is unknown: its edges are ignored.)
    const y = (id: string) => nodes.get(id)!.y
    expect(Math.sign(y('p1') - y('p2'))).toBe(Math.sign(y('c1') - y('c2')))
  })

  it('puts nodes without edges in a grid below, never overlapping', () => {
    const loose = Array.from({ length: 10 }, (_, i) => box(`x${i}`, 60 + i * 5))
    const { nodes, width, height } = layoutGraph([box('a'), box('b'), ...loose], [{ from: 'a', to: 'b' }])
    const aBottom = nodes.get('a')!.y + 24
    for (const n of loose) {
      expect(nodes.get(n.id)!.layer).toBe(-1)
      expect(nodes.get(n.id)!.y).toBeGreaterThan(aBottom)
    }
    expect(noOverlaps(nodes)).toBe(true)
    for (const p of nodes.values()) {
      expect(p.x + p.width).toBeLessThanOrEqual(width + 0.001)
      expect(p.y + p.height).toBeLessThanOrEqual(height + 0.001)
    }
  })

  it('stays fast on a big project (2000 modules)', () => {
    const n = 2000
    const nodes = Array.from({ length: n }, (_, i) => box(`m${i}`, 100))
    const edges = Array.from({ length: n * 3 }, (_, i) => ({ from: `m${(i * 7919) % n}`, to: `m${(i * 104729 + 13) % n}` }))
    const t = performance.now()
    const res = layoutGraph(nodes, edges)
    expect(res.nodes.size).toBe(n)
    expect(performance.now() - t).toBeLessThan(3000)
    expect(noOverlaps(res.nodes)).toBe(true)
  })

  it('empty graph', () => {
    expect(layoutGraph([], [])).toEqual({ nodes: new Map(), width: 0, height: 0 })
  })
})
