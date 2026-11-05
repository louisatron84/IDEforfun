import { describe, expect, it } from 'vitest'
import { findConflicts, normalizeKey, normalizeKeybindings, toAccelerator } from './keybindings'

describe('normalizeKey', () => {
  it('writes shortcuts the way key events produce them', () => {
    expect(normalizeKey('ctrl+shift+p')).toBe('Ctrl+Shift+P')
    expect(normalizeKey('Shift+Ctrl+P')).toBe('Ctrl+Shift+P')
    expect(normalizeKey('cmd+k')).toBe('Ctrl+K')
    expect(normalizeKey(' alt + left ')).toBe('Alt+ArrowLeft')
    expect(normalizeKey('f5')).toBe('F5')
    expect(normalizeKey('Ctrl+`')).toBe('Ctrl+`')
    expect(normalizeKey('Ctrl++')).toBe('Ctrl++')
    expect(normalizeKey('ctrl+pagedown')).toBe('Ctrl+PageDown')
    expect(normalizeKey('Escape')).toBe('Escape')
  })
  it('rejects things that are not one key', () => {
    expect(normalizeKey('')).toBeNull()
    expect(normalizeKey('Ctrl')).toBeNull()
    expect(normalizeKey('Ctrl+A+B')).toBeNull()
    expect(normalizeKey('Ctrl+Banana')).toBeNull()
    expect(normalizeKey('F99')).toBeNull()
  })
})

describe('normalizeKeybindings', () => {
  it('accepts a key, a list of keys, or null to remove', () => {
    expect(normalizeKeybindings({ 'run.file': 'ctrl+r', 'palette.files': ['Ctrl+P', 'ctrl+e', 'Ctrl+P'], 'nav.back': null }))
      .toEqual({ 'run.file': ['Ctrl+R'], 'palette.files': ['Ctrl+P', 'Ctrl+E'], 'nav.back': [] })
  })
  it('drops garbage instead of failing', () => {
    expect(normalizeKeybindings('nope')).toEqual({})
    expect(normalizeKeybindings([1, 2])).toEqual({})
    expect(normalizeKeybindings({ 'a.b': 42, 'bad id!': 'Ctrl+A', 'c.d': ['Ctrl+Nope'] })).toEqual({})
  })
})

describe('findConflicts', () => {
  it('lists keys shared by several commands', () => {
    const c = findConflicts([
      { id: 'a', keys: ['Ctrl+R', 'F1'] },
      { id: 'b', keys: ['Ctrl+R'] },
      { id: 'c', keys: ['F2'] }
    ])
    expect([...c]).toEqual([['Ctrl+R', ['a', 'b']]])
  })
})

describe('toAccelerator', () => {
  it('converts to Electron menu accelerators', () => {
    expect(toAccelerator('Ctrl+Shift+P')).toBe('CmdOrCtrl+Shift+P')
    expect(toAccelerator('Alt+ArrowLeft')).toBe('Alt+Left')
    expect(toAccelerator('F5')).toBe('F5')
  })
})

describe('space', () => {
  it('is written as Space', () => {
    expect(normalizeKey('ctrl+space')).toBe('Ctrl+Space')
    expect(toAccelerator('Ctrl+Space')).toBe('CmdOrCtrl+Space')
  })
})
