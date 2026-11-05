import { describe, expect, it } from 'vitest'
import { applyEdits, parseLocations, parseSymbols, parseWorkspaceEdit, symbolPathAt } from './navigation'

const r = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } })

describe('parseLocations', () => {
  it('reads locations and links, sorted', () => {
    const locs = parseLocations([
      { uri: 'file:///p/b.py', range: r(3, 0, 3, 4) },
      { targetUri: 'file:///p/a.py', targetSelectionRange: r(1, 2, 1, 5), targetRange: r(0, 0, 9, 0) },
      { uri: 'file:///p/b.py', range: r(1, 0, 1, 4) },
      { nonsense: true }
    ])
    expect(locs.map((l) => `${l.path}:${l.start.line}:${l.start.col}`)).toEqual(['/p/a.py:1:2', '/p/b.py:1:0', '/p/b.py:3:0'])
    expect(parseLocations(null)).toEqual([])
  })
})

describe('parseWorkspaceEdit', () => {
  it('reads documentChanges', () => {
    const e = parseWorkspaceEdit({
      documentChanges: [
        { textDocument: { uri: 'file:///p/a.py', version: 3 }, edits: [{ range: r(0, 4, 0, 7), newText: 'bar' }] },
        { kind: 'rename', oldUri: 'file:///p/x.py', newUri: 'file:///p/y.py' }
      ]
    })
    expect([...e]).toEqual([['/p/a.py', [{ start: { line: 0, col: 4 }, end: { line: 0, col: 7 }, text: 'bar' }]]])
  })
  it('reads changes', () => {
    const e = parseWorkspaceEdit({ changes: { 'file:///p/a.py': [{ range: r(1, 0, 1, 1), newText: 'z' }], 'file:///p/b.py': [] } })
    expect([...e.keys()]).toEqual(['/p/a.py'])
  })
})

describe('parseSymbols', () => {
  it('reads a symbol tree, sorted by position', () => {
    const syms = parseSymbols([
      { name: 'helper', kind: 12, range: r(10, 0, 12, 0), selectionRange: r(10, 4, 10, 10), children: [] },
      { name: 'Dog', kind: 5, range: r(0, 0, 8, 0), selectionRange: r(0, 6, 0, 9), children: [
        { name: 'bark', kind: 6, detail: '(self) -> None', range: r(4, 4, 6, 0), selectionRange: r(4, 8, 4, 12) },
        { name: '__init__', kind: 6, range: r(1, 4, 3, 0), selectionRange: r(1, 8, 1, 16) }
      ] }
    ])
    expect(syms.map((s) => s.name)).toEqual(['Dog', 'helper'])
    expect(syms[0].children.map((s) => s.name)).toEqual(['__init__', 'bark'])
    expect(syms[0].children[1]).toMatchObject({ detail: '(self) -> None', nameStart: { line: 4, col: 8 } })
    expect(symbolPathAt(syms, { line: 5, col: 2 }).map((s) => s.name)).toEqual(['Dog', 'bark'])
    expect(symbolPathAt(syms, { line: 9, col: 0 })).toEqual([])
  })
  it('accepts flat SymbolInformation', () => {
    const syms = parseSymbols([{ name: 'x', kind: 13, location: { uri: 'file:///p/a.py', range: r(2, 0, 2, 5) } }])
    expect(syms).toMatchObject([{ name: 'x', kind: 13, start: { line: 2, col: 0 } }])
  })
})

describe('applyEdits', () => {
  it('applies several edits and keeps the line endings', () => {
    const text = 'def foo():\r\n    return foo\r\nfoo()\r\n'
    const out = applyEdits(text, [
      { start: { line: 0, col: 4 }, end: { line: 0, col: 7 }, text: 'bar' },
      { start: { line: 1, col: 11 }, end: { line: 1, col: 14 }, text: 'bar' },
      { start: { line: 2, col: 0 }, end: { line: 2, col: 3 }, text: 'bar' }
    ])
    expect(out).toBe('def bar():\r\n    return bar\r\nbar()\r\n')
  })
  it('handles inserts, multi-line edits and positions past the end', () => {
    expect(applyEdits('a\nb\nc', [{ start: { line: 0, col: 1 }, end: { line: 2, col: 0 }, text: '-' }])).toBe('a-c')
    expect(applyEdits('ab', [{ start: { line: 0, col: 99 }, end: { line: 0, col: 99 }, text: '!' }])).toBe('ab!')
    expect(applyEdits('ab', [{ start: { line: 5, col: 0 }, end: { line: 5, col: 0 }, text: '\nc' }])).toBe('ab\nc')
  })
})
