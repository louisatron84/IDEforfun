import { describe, expect, it } from 'vitest'
import { isAppShortcut, setAppShortcutCheck } from './terminalKeys'

const key = (k: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

describe('keys the terminal leaves to Forge', () => {
  it('task switching (Ctrl+Alt+1…4) and the graph (Ctrl+Alt+G)', () => {
    for (const d of ['1', '2', '3', '4']) expect(isAppShortcut(key(d, { ctrlKey: true, altKey: true }))).toBe(true)
    expect(isAppShortcut(key('g', { ctrlKey: true, altKey: true }))).toBe(true)
  })

  it('ordinary terminal keys stay in the terminal', () => {
    expect(isAppShortcut(key('2', { altKey: true }))).toBe(false)
    expect(isAppShortcut(key('c', { ctrlKey: true }))).toBe(false)
    expect(isAppShortcut(key('5', { ctrlKey: true, altKey: true }))).toBe(false)
  })
})

describe('Forge decides which keys the terminal hands back', () => {
  it('uses the check Forge sets (e.g. Ctrl+O, Ctrl+J), and the defaults when cleared', () => {
    setAppShortcutCheck((e) => e.ctrlKey && ['o', 'j'].includes(e.key.toLowerCase()))
    expect(isAppShortcut(key('o', { ctrlKey: true }))).toBe(true)
    expect(isAppShortcut(key('c', { ctrlKey: true }))).toBe(false)
    setAppShortcutCheck(null)
    expect(isAppShortcut(key('o', { ctrlKey: true }))).toBe(false)
    expect(isAppShortcut(key('2', { ctrlKey: true, altKey: true }))).toBe(true)
  })
})
