import { describe, expect, it } from 'vitest'
import { CommandRegistry, keyString } from './keymap'

const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
  ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent

describe('keyString', () => {
  it('builds a normalized shortcut string', () => {
    expect(keyString(ev('s', { ctrlKey: true }))).toBe('Ctrl+S')
    expect(keyString(ev('P', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+P')
    expect(keyString(ev('F5'))).toBe('F5')
    expect(keyString(ev('F5', { shiftKey: true }))).toBe('Shift+F5')
    expect(keyString(ev('`', { ctrlKey: true }))).toBe('Ctrl+`')
    expect(keyString(ev('Tab', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Tab')
    expect(keyString(ev(',', { ctrlKey: true }))).toBe('Ctrl+,')
  })
  it('treats Cmd (macOS) like Ctrl', () => {
    expect(keyString(ev('s', { metaKey: true }))).toBe('Ctrl+S')
  })
  it('returns empty for bare modifier presses', () => {
    expect(keyString(ev('Control', { ctrlKey: true }))).toBe('')
  })
})

describe('CommandRegistry', () => {
  it('runs a command by shortcut and reports whether it handled the key', () => {
    const reg = new CommandRegistry()
    let saved = 0
    reg.register({ id: 'file.save', title: 'Save', keys: 'Ctrl+S', run: () => { saved++ } })
    expect(reg.handleKey(ev('s', { ctrlKey: true }))).toBe(true)
    expect(reg.handleKey(ev('d', { ctrlKey: true }))).toBe(false)
    expect(saved).toBe(1)
  })
  it('skips commands whose `when` condition is false', () => {
    const reg = new CommandRegistry()
    let ran = false
    reg.register({ id: 'x', title: 'X', keys: 'F5', when: () => false, run: () => { ran = true } })
    expect(reg.handleKey(ev('F5'))).toBe(false)
    expect(ran).toBe(false)
  })
  it('lists commands for the palette', () => {
    const reg = new CommandRegistry()
    reg.register({ id: 'a', title: 'Alpha', run: () => {} })
    reg.register({ id: 'b', title: 'Beta', keys: 'F1', run: () => {} })
    expect(reg.all().map((c) => c.title)).toEqual(['Alpha', 'Beta'])
  })
})

describe('CommandRegistry with your own shortcuts', () => {
  const setup = () => {
    const reg = new CommandRegistry()
    const ran: string[] = []
    reg.register({ id: 'a', title: 'A', keys: 'Ctrl+R', run: () => { ran.push('a') } })
    reg.register({ id: 'b', title: 'B', keys: ['F1', 'F2'], run: () => { ran.push('b') } })
    return { reg, ran }
  }
  it('replaces the default keys of changed commands only', () => {
    const { reg, ran } = setup()
    reg.setOverrides({ a: ['Ctrl+E'] })
    expect(reg.keysOf('a')).toEqual(['Ctrl+E'])
    expect(reg.keysOf('b')).toEqual(['F1', 'F2'])
    expect(reg.defaultKeys('a')).toEqual(['Ctrl+R'])
    expect(reg.handleKey(ev('r', { ctrlKey: true }))).toBe(false)
    expect(reg.handleKey(ev('e', { ctrlKey: true }))).toBe(true)
    expect(ran).toEqual(['a'])
  })
  it('an empty list removes the shortcut', () => {
    const { reg } = setup()
    reg.setOverrides({ b: [] })
    expect(reg.handleKey(ev('F1'))).toBe(false)
    expect(reg.menuKeys()).toEqual({ a: 'Ctrl+R', b: null })
  })
  it('finds the command for a key', () => {
    const { reg } = setup()
    expect(reg.commandForKey('F2')?.id).toBe('b')
    expect(reg.commandForKey('F3')).toBeUndefined()
  })
})
