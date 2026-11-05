import { describe, expect, it } from 'vitest'
import { parsePorcelain, classify, buildStatusMap } from './git'

// `git status --porcelain=v1 -z`: entries are "XY path" separated by NUL;
// renames/copies are followed by an extra NUL-separated original path.
const z = (...entries: string[]) => entries.join('\0') + '\0'

describe('parsePorcelain', () => {
  it('parses status codes and paths, including spaces', () => {
    expect(parsePorcelain(z(' M src/app.py', '?? new file.py', 'A  added.py', ' D gone.py'))).toEqual([
      { x: ' ', y: 'M', path: 'src/app.py' },
      { x: '?', y: '?', path: 'new file.py' },
      { x: 'A', y: ' ', path: 'added.py' },
      { x: ' ', y: 'D', path: 'gone.py' }
    ])
  })
  it('handles renames (new path first, then the original)', () => {
    expect(parsePorcelain(z('R  new.py', 'old.py', ' M other.py'))).toEqual([
      { x: 'R', y: ' ', path: 'new.py', from: 'old.py' },
      { x: ' ', y: 'M', path: 'other.py' }
    ])
  })
  it('returns nothing for a clean tree', () => {
    expect(parsePorcelain('')).toEqual([])
  })
})

describe('classify', () => {
  it('maps git codes to simple states', () => {
    expect(classify(' ', 'M')).toBe('modified')
    expect(classify('M', ' ')).toBe('modified')
    expect(classify('?', '?')).toBe('untracked')
    expect(classify('A', ' ')).toBe('added')
    expect(classify('A', 'M')).toBe('added')
    expect(classify(' ', 'D')).toBe('deleted')
    expect(classify('R', ' ')).toBe('renamed')
    expect(classify('U', 'U')).toBe('conflict')
    expect(classify('A', 'A')).toBe('conflict')
    expect(classify('D', 'D')).toBe('conflict')
  })
})

describe('buildStatusMap', () => {
  it('gives absolute paths for files and marks every parent folder up to the opened folder', () => {
    const map = buildStatusMap('C:\\repo', 'C:\\repo\\sub', parsePorcelain(z(' M sub/pkg/a.py', '?? sub/b.py', ' M outside.py')))
    expect(map).toEqual({
      files: { 'C:\\repo\\sub\\pkg\\a.py': 'modified', 'C:\\repo\\sub\\b.py': 'untracked' },
      folders: ['C:\\repo\\sub\\pkg']
    })
  })
  it('works with forward-slash roots too', () => {
    const map = buildStatusMap('/r', '/r', parsePorcelain(z('A  x/y.py')))
    expect(map).toEqual({ files: { '/r/x/y.py': 'added' }, folders: ['/r/x'] })
  })
})
