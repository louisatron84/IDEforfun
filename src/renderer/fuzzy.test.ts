import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyFilter } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches characters in order, case-insensitively, and reports their positions', () => {
    const m = fuzzyMatch('rpf', 'Run Python File')
    expect(m).not.toBeNull()
    expect(m!.positions).toEqual([0, 4, 11])
  })
  it('returns null when characters are missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'Run Python File')).toBeNull()
    expect(fuzzyMatch('fr', 'Run File')).toBeNull()
  })
  it('an empty query matches everything with score 0', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] })
  })
  it('scores word starts and consecutive runs above scattered letters', () => {
    const wordStarts = fuzzyMatch('sf', 'Save File')!.score
    const scattered = fuzzyMatch('sf', 'classify')!.score
    expect(wordStarts).toBeGreaterThan(scattered)
    const run = fuzzyMatch('save', 'Save File')!.score
    const split = fuzzyMatch('save', 'Search And View Editor')!.score
    expect(run).toBeGreaterThan(split)
  })
  it('treats path separators, underscores and dots as word boundaries', () => {
    const m = fuzzyMatch('mfp', 'src/main/file_parser.py')!
    expect(m.positions).toEqual([4, 9, 14])
  })
})

describe('fuzzyFilter', () => {
  it('sorts by score and prefers shorter text on ties', () => {
    const items = ['src/editor/editor.ts', 'src/editor/editor.test.ts', 'docs/readme.md']
    expect(fuzzyFilter('editor', items, (s) => s).map((r) => r.item)).toEqual([
      'src/editor/editor.ts',
      'src/editor/editor.test.ts'
    ])
  })
  it('for file paths, a match in the file name beats one only in folders', () => {
    const items = ['find/notes.txt', 'src/find.ts']
    expect(fuzzyFilter('find', items, (s) => s)[0].item).toBe('src/find.ts')
  })
})
