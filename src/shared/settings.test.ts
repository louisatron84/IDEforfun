import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'

describe('normalizeSettings', () => {
  it('fills in defaults for missing or garbage input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })
  it('keeps valid values', () => {
    const s = { fontSize: 18, theme: 'light', tabSize: 2, pythonPath: 'C:\\Py\\python.exe' }
    expect(normalizeSettings(s)).toEqual(s)
  })
  it('clamps the font size and rounds it', () => {
    expect(normalizeSettings({ fontSize: 3 }).fontSize).toBe(10)
    expect(normalizeSettings({ fontSize: 99 }).fontSize).toBe(28)
    expect(normalizeSettings({ fontSize: 15.6 }).fontSize).toBe(16)
  })
  it('rejects unknown themes and tab sizes', () => {
    expect(normalizeSettings({ theme: 'purple' }).theme).toBe('dark')
    expect(normalizeSettings({ tabSize: 3 }).tabSize).toBe(4)
  })
  it('trims the python path and treats blank as automatic', () => {
    expect(normalizeSettings({ pythonPath: '   ' }).pythonPath).toBe('')
    expect(normalizeSettings({ pythonPath: ' py ' }).pythonPath).toBe('py')
  })
})
