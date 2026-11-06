import { describe, expect, it } from 'vitest'
import { graphLayout, parseBlame, parseLog, timeAgo, type Commit } from './history'
import { conflictNear, findConflicts, resolveConflict } from './conflicts'

describe('parseLog', () => {
  it('reads commits with parents, refs and subjects', () => {
    const out = [
      'aaaaaaa1\0bbbbbbb2 ccccccc3\0Ada\0' + '1700000000\0HEAD -> main, origin/main\0Merge branch x\x1e',
      '\nbbbbbbb2\0\0Bob\0' + '1690000000\0\0first: with, commas\x1e\n'
    ].join('')
    expect(parseLog(out)).toEqual([
      { sha: 'aaaaaaa1', parents: ['bbbbbbb2', 'ccccccc3'], author: 'Ada', time: 1700000000, refs: ['HEAD -> main', 'origin/main'], subject: 'Merge branch x' },
      { sha: 'bbbbbbb2', parents: [], author: 'Bob', time: 1690000000, refs: [], subject: 'first: with, commas' }
    ])
  })
})

describe('graphLayout', () => {
  const c = (sha: string, ...parents: string[]): Commit => ({ sha, parents, author: '', time: 0, refs: [], subject: '' })
  it('keeps a straight line for linear history', () => {
    const rows = graphLayout([c('c', 'b'), c('b', 'a'), c('a')])
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(rows[2].after).toEqual([])
  })
  it('opens a column for a merged branch and joins it back', () => {
    // m merges f into main: m(b, f), f(a), b(a), a
    const rows = graphLayout([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')])
    expect(rows[0]).toMatchObject({ col: 0, parentCols: [0, 1], after: ['b', 'f'] })
    expect(rows[1]).toMatchObject({ col: 1, after: ['b', 'a'] }) // f on the side branch
    // b also leads to a: the side column (also waiting for a) joins at a.
    expect(rows[2]).toMatchObject({ col: 0, after: ['a', 'a'] })
    expect(rows[3]).toMatchObject({ col: 0, joins: [1], after: [] })
  })
})

describe('parseBlame', () => {
  it('reads author, time and summary for every line', () => {
    const A = 'a'.repeat(40)
    const Z = '0'.repeat(40)
    const out = [
      `${A} 1 1 2`, 'author Ada', 'author-time 1700000000', 'summary First commit', 'filename x.py', '\tline one',
      `${A} 2 2`, '\tline two',
      `${Z} 3 3 1`, 'author Not Committed Yet', 'author-time 1800000000', 'summary Version of x.py from x.py', 'filename x.py', '\tnew line', ''
    ].join('\n')
    const b = parseBlame(out)
    expect(b).toHaveLength(3)
    expect(b[0]).toMatchObject({ sha: A, author: 'Ada', summary: 'First commit', uncommitted: false })
    expect(b[1].sha).toBe(A)
    expect(b[2]).toMatchObject({ uncommitted: true })
  })
})

describe('timeAgo', () => {
  it('says roughly how long ago', () => {
    const now = 1_700_000_000_000
    expect(timeAgo(now / 1000 - 30, now)).toBe('just now')
    expect(timeAgo(now / 1000 - 3 * 86400, now)).toBe('3 days ago')
    expect(timeAgo(now / 1000 - 400 * 86400, now)).toBe('1 year ago')
  })
})

describe('merge conflicts', () => {
  const lines = [
    'a = 1',
    '<<<<<<< HEAD',
    'b = 2',
    '||||||| base',
    'b = 0',
    '=======',
    'b = 3',
    'b2 = 3',
    '>>>>>>> feature',
    'c = 4',
    '<<<<<<< ours',
    '=======',
    'd = 5',
    '>>>>>>> theirs',
    '<<<<<<< never closed'
  ]
  it('finds complete conflict blocks', () => {
    const cs = findConflicts(lines)
    expect(cs).toEqual([
      { start: 1, base: 3, separator: 5, end: 8, currentLabel: 'HEAD', incomingLabel: 'feature' },
      { start: 10, base: null, separator: 11, end: 13, currentLabel: 'ours', incomingLabel: 'theirs' }
    ])
  })
  it('resolves either way or both', () => {
    const [c1, c2] = findConflicts(lines)
    expect(resolveConflict(lines, c1, 'current')).toEqual(['b = 2'])
    expect(resolveConflict(lines, c1, 'incoming')).toEqual(['b = 3', 'b2 = 3'])
    expect(resolveConflict(lines, c1, 'both')).toEqual(['b = 2', 'b = 3', 'b2 = 3'])
    expect(resolveConflict(lines, c2, 'current')).toEqual([])
  })
  it('picks the conflict at or after the cursor', () => {
    const cs = findConflicts(lines)
    expect(conflictNear(cs, 4)?.start).toBe(1)
    expect(conflictNear(cs, 9)?.start).toBe(10)
    expect(conflictNear(cs, 14)?.start).toBe(1) // wraps
  })
})
