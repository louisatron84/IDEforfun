import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'

describe('normalizeSettings', () => {
  it('fills in defaults for missing or garbage input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })
  it('keeps valid values', () => {
    const s = { fontSize: 18, theme: 'light', tabSize: 2, pythonPath: 'C:\\Py\\python.exe', shell: 'gitbash', reopenLastProject: false, showWelcome: false, formatter: 'black', formatOnSave: true, lintWithRuff: false, debugInTerminal: false }
    expect(normalizeSettings(s)).toEqual(s)
  })
  it('only accepts plain shell ids', () => {
    expect(normalizeSettings({ shell: 'rm -rf /' }).shell).toBe('')
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

describe('project settings', () => {
  it('keeps only valid project-level values', async () => {
    const { normalizeProjectSettings, effectiveSettings } = await import('./settings')
    expect(normalizeProjectSettings({ tabSize: 2, pythonPath: ' .venv/bin/python ', shell: 'bash', fontSize: 30, theme: 'light' }))
      .toEqual({ tabSize: 2, pythonPath: '.venv/bin/python', shell: 'bash' })
    expect(normalizeProjectSettings({ tabSize: 3, shell: 'a b' })).toEqual({})
    expect(normalizeProjectSettings([1])).toEqual({})
    expect(effectiveSettings(DEFAULT_SETTINGS, { tabSize: 2 }).tabSize).toBe(2)
  })
})
