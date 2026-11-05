import { describe, expect, it } from 'vitest'
import { FoldMap, enclosingBlock, foldEnd, isFoldable } from './folding'

const src = [
  'class A:', //        0
  '    def f(self):', // 1
  '        x = 1', //    2
  '', //                 3
  '        return x', // 4
  '', //                 5
  '    def g(self):', // 6
  '        pass', //     7
  '', //                 8
  'print(A)' //          9
]
const get = (l: number) => src[l]
const n = src.length

describe('finding blocks', () => {
  it('a block is the deeper-indented lines after a line, without trailing blank lines', () => {
    expect(foldEnd(get, n, 0)).toBe(7)
    expect(foldEnd(get, n, 1)).toBe(4)
    expect(foldEnd(get, n, 6)).toBe(7)
  })
  it('lines that start nothing do not fold', () => {
    expect(foldEnd(get, n, 2)).toBeNull()
    expect(foldEnd(get, n, 3)).toBeNull()
    expect(foldEnd(get, n, 9)).toBeNull()
    expect(isFoldable(get, n, 1)).toBe(true)
    expect(isFoldable(get, n, 4)).toBe(false)
  })
  it('the enclosing block of a body line is its header', () => {
    expect(enclosingBlock(get, n, 2)).toBe(1)
    expect(enclosingBlock(get, n, 1)).toBe(1)
    expect(enclosingBlock(get, n, 7)).toBe(6)
    expect(enclosingBlock(get, n, 9)).toBeNull()
  })
})

describe('FoldMap', () => {
  const end = (h: number) => foldEnd(get, n, h)
  it('maps lines to screen rows around a fold', () => {
    const m = new FoldMap([1], end) // hides 2..4
    expect(m.ranges).toEqual([[2, 4]])
    expect(m.visibleCount(n)).toBe(7)
    expect(m.visualLine(1)).toBe(1)
    expect(m.visualLine(3)).toBe(1) // hidden: its header's row
    expect(m.visualLine(5)).toBe(2)
    expect(m.bufferLine(2)).toBe(5)
    expect(m.bufferLine(1)).toBe(1)
    expect(m.isHidden(4)).toBe(true)
    expect(m.isFolded(1)).toBe(true)
  })
  it('a fold inside a folded block is ignored', () => {
    const m = new FoldMap([0, 1, 6], end)
    expect(m.ranges).toEqual([[1, 7]])
    expect(m.bufferLine(1)).toBe(8)
    expect(m.headers).toEqual([0])
  })
  it('several folds', () => {
    const m = new FoldMap([6, 1], end)
    expect(m.ranges).toEqual([[2, 4], [7, 7]])
    for (let row = 0; row < m.visibleCount(n); row++) expect(m.visualLine(m.bufferLine(row))).toBe(row)
    expect(m.bufferLine(4)).toBe(8)
  })
  it('the empty map changes nothing', () => {
    expect(FoldMap.empty.visualLine(5)).toBe(5)
    expect(FoldMap.empty.bufferLine(5)).toBe(5)
  })
})
