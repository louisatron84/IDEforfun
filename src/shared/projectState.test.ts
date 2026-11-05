import { describe, expect, it } from 'vitest'
import { addRecent, MAX_RECENT, normalizeRecent, normalizeWorkspaceState, removeRecent } from './projectState'

describe('recent projects', () => {
  it('puts the newest first without duplicates', () => {
    let list = addRecent([], '/a')
    list = addRecent(list, '/b')
    list = addRecent(list, '/a/')
    expect(list).toEqual(['/a/', '/b'])
  })
  it('treats Windows paths as the same regardless of case and slashes', () => {
    const list = addRecent(['C:\\Code\\App', 'D:\\x'], 'c:/code/app')
    expect(list).toEqual(['c:/code/app', 'D:\\x'])
    expect(removeRecent(list, 'C:\\CODE\\APP')).toEqual(['D:\\x'])
  })
  it('keeps at most MAX_RECENT', () => {
    let list: string[] = []
    for (let i = 0; i < MAX_RECENT + 5; i++) list = addRecent(list, `/p${i}`)
    expect(list).toHaveLength(MAX_RECENT)
    expect(list[0]).toBe(`/p${MAX_RECENT + 4}`)
  })
  it('cleans a stored list', () => {
    expect(normalizeRecent(['/a', 3, '', '/a', '/b'])).toEqual(['/a', '/b'])
    expect(normalizeRecent('x')).toEqual([])
  })
})

describe('normalizeWorkspaceState', () => {
  it('gives an empty layout for garbage', () => {
    expect(normalizeWorkspaceState(null)).toEqual({ groups: [{ tabs: [], active: null }], activeGroup: 0, terminals: [], panel: null, runConfig: null })
  })
  it('keeps valid tabs and fixes the rest', () => {
    const s = normalizeWorkspaceState({
      groups: [
        { tabs: [{ path: '/a.py', line: 3.7, col: -1, scrollTop: 40 }, { nope: 1 }], active: '/missing.py' },
        { tabs: [{ path: '/b.py' }], active: '/b.py' },
        { tabs: [{ path: '/c.py' }] }
      ],
      activeGroup: 9,
      terminals: ['powershell', 'bad id;', ''],
      panel: 'terminal'
    })
    expect(s.groups).toEqual([
      { tabs: [{ path: '/a.py', line: 3, col: 0, scrollTop: 40 }], active: '/a.py' },
      { tabs: [{ path: '/b.py', line: 0, col: 0, scrollTop: 0 }], active: '/b.py' }
    ])
    expect(s.activeGroup).toBe(1)
    expect(s.terminals).toEqual(['powershell', ''])
    expect(s.panel).toBe('terminal')
  })
})
