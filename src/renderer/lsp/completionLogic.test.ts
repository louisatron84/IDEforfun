import { describe, expect, it } from 'vitest'
import { wordStartAt, filterCompletions, completionEdit, type CompletionItem } from './completionLogic'

const item = (label: string, extra: Partial<CompletionItem> = {}): CompletionItem => ({ label, kind: 6, ...extra })

describe('wordStartAt', () => {
  it('finds the start of the identifier before the cursor', () => {
    expect(wordStartAt('    result = os.pa', 18)).toBe(16)
    expect(wordStartAt('x = my_var', 10)).toBe(4)
    expect(wordStartAt('foo.', 4)).toBe(4) // right after a dot: empty prefix
    expect(wordStartAt('', 0)).toBe(0)
  })
})

describe('filterCompletions', () => {
  const items = [
    item('path', { sortText: '09' }),
    item('pathsep', { sortText: '10' }),
    item('getpid', { sortText: '01' }),
    item('_private', { sortText: '99' })
  ]
  it('with an empty prefix keeps the server order (sortText)', () => {
    expect(filterCompletions(items, '').map((i) => i.label)).toEqual(['getpid', 'path', 'pathsep', '_private'])
  })
  it('keeps fuzzy matches, best match first', () => {
    // "getpid" has no "a", so it drops out; "_private" matches p…a, but after the prefix matches.
    expect(filterCompletions(items, 'pa').map((i) => i.label)).toEqual(['path', 'pathsep', '_private'])
  })
  it('uses filterText when given', () => {
    const r = filterCompletions([item('display', { filterText: 'zzz' })], 'zz')
    expect(r.map((i) => i.label)).toEqual(['display'])
  })
  it('matching case wins: "Do" ranks Dog above dog', () => {
    expect(filterCompletions([item('dog'), item('Dog')], 'Do')[0].label).toBe('Dog')
    expect(filterCompletions([item('Dog'), item('dog')], 'do')[0].label).toBe('dog')
  })
  it('an exact match comes first', () => {
    const r = filterCompletions([item('items_list'), item('items')], 'items')
    expect(r[0].label).toBe('items')
  })
})

describe('completionEdit', () => {
  const pos = { line: 2, col: 10 }
  it('replaces the typed prefix with the insert text', () => {
    expect(completionEdit(item('pathsep', { insertText: 'pathsep' }), 'x = os.pat', pos)).toEqual({
      start: { line: 2, col: 7 }, end: pos, text: 'pathsep'
    })
  })
  it('falls back to the label', () => {
    expect(completionEdit(item('getcwd'), 'x = os.get', pos).text).toBe('getcwd')
  })
  it("uses the server's textEdit range, extended to the cursor", () => {
    const e = completionEdit(item('append', { textEdit: { start: { line: 2, col: 8 }, end: { line: 2, col: 9 }, text: 'append' } }), 'items.ap', pos)
    expect(e).toEqual({ start: { line: 2, col: 8 }, end: pos, text: 'append' })
  })
})
