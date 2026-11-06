import { describe, expect, it } from 'vitest'
import { csvPreview, defaultTicks, fieldKey, fieldTree, pickRecords, pyJson, recordLists, rowsFor } from './apiFields'

const fixture = { items: [{ a: 1 }, { a: 2, b: { c: 'x' } }], meta: { n: 2 } }

describe('finding the records', () => {
  it('recordLists finds lists of objects, largest first', () => {
    expect(recordLists(fixture)).toEqual([{ path: ['items'], count: 2 }])
    expect(recordLists([{ a: 1 }])).toEqual([{ path: [], count: 1 }])
    expect(recordLists({ x: { big: [{}, {}, {}] }, small: [{}] })).toEqual([{ path: ['x', 'big'], count: 3 }, { path: ['small'], count: 1 }])
    expect(recordLists({ nums: [1, 2] })).toEqual([])
  })

  it('pickRecords: largest list, a chosen path, a bare object, plain values', () => {
    expect(pickRecords(fixture, null)).toEqual({ records: fixture.items, path: ['items'] })
    expect(pickRecords({ a: [{ x: 1 }], b: [{ y: 1 }, { y: 2 }] }, ['a']).records).toEqual([{ x: 1 }])
    expect(pickRecords({ x: 1 }, null)).toEqual({ records: [{ x: 1 }], path: null })
    expect(pickRecords([1, 2], null)).toEqual({ records: [{ value: 1 }, { value: 2 }], path: [] })
    expect(pickRecords([], null)).toEqual({ records: [], path: [] })
    expect(pickRecords('hello', null)).toEqual({ records: [{ value: 'hello' }], path: null })
  })
})

describe('fields', () => {
  it('fieldTree merges all records and nests objects', () => {
    const tree = fieldTree(fixture.items)
    expect(tree.map((f) => [f.name, f.kind, f.sample])).toEqual([['a', 'value', '1'], ['b', 'object', '']])
    expect(tree[1].children).toEqual([{ path: ['b', 'c'], name: 'c', kind: 'value', sample: 'x', children: [] }])
    expect(fieldKey(tree[1].children[0].path)).toBe('b.c')
  })

  it('a field that is null at first takes its kind from a later record', () => {
    const tree = fieldTree([{ p: null }, { p: { q: 1 } }])
    expect(tree[0].kind).toBe('object')
    expect(tree[0].children[0].name).toBe('q')
  })

  it('lists are single fields; samples are short', () => {
    const tree = fieldTree([{ tags: ['a', 'b'], long: 'x'.repeat(100) }])
    expect(tree[0]).toMatchObject({ kind: 'list', sample: '["a", "b"]' })
    expect(tree[1].sample.length).toBeLessThanOrEqual(60)
  })

  it('defaultTicks: top-level plain fields and lists, not nested ones', () => {
    expect(defaultTicks(fieldTree(fixture.items))).toEqual(['a'])
    expect(defaultTicks(fieldTree([{ tags: [], o: { x: 1 } }]))).toEqual(['tags'])
    expect(fieldTree([])).toEqual([])
  })
})

describe('rows and CSV', () => {
  it('rowsFor keeps the ticked fields, in order', () => {
    expect(rowsFor(fixture.items, ['a', 'b.c'])).toEqual([{ a: '1', 'b.c': '' }, { a: '2', 'b.c': 'x' }])
  })

  it('cells: null empty, booleans and containers as JSON text', () => {
    expect(rowsFor([{ n: null, t: true, l: ['a', 'b'], o: { k: 'é' } }], ['n', 't', 'l', 'o'])).toEqual([
      { n: '', t: 'true', l: '["a", "b"]', o: '{"k": "\\u00e9"}' }
    ])
  })

  it('pyJson matches Python json.dumps', () => {
    expect(pyJson({ a: [1, 'x', null, false], b: {} })).toBe('{"a": [1, "x", null, false], "b": {}}')
    expect(pyJson('tab\there')).toBe('"tab\\there"')
  })

  it('csvPreview quotes like Python csv and uses CRLF', () => {
    const rows = [{ a: 'a,b', b: 'say "hi"' }, { a: 'plain', b: 'two\nlines' }]
    expect(csvPreview(rows, ['a', 'b'])).toBe('a,b\r\n"a,b","say ""hi"""\r\nplain,"two\nlines"\r\n')
    expect(csvPreview([{ a: '1' }, { a: '2' }, { a: '3' }], ['a'], 2)).toBe('a\r\n1\r\n2\r\n')
  })
})
