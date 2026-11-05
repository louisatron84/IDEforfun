import { describe, expect, it } from 'vitest'
import { sortAndFilterEntries } from './dirEntries'

const e = (name: string, isDirectory = false) => ({ name, isDirectory })

describe('sortAndFilterEntries', () => {
  it('puts folders before files, each sorted case-insensitively', () => {
    const out = sortAndFilterEntries('/p', [e('b.py'), e('Zeta', true), e('A.txt'), e('alpha', true)])
    expect(out.map((x) => x.name)).toEqual(['alpha', 'Zeta', 'A.txt', 'b.py'])
  })

  it('hides noise folders', () => {
    const out = sortAndFilterEntries('/p', [
      e('.git', true), e('node_modules', true), e('__pycache__', true), e('.venv', true), e('src', true)
    ])
    expect(out.map((x) => x.name)).toEqual(['src'])
  })

  it('builds full paths', () => {
    const [entry] = sortAndFilterEntries('/proj', [e('main.py')])
    expect(entry.path).toMatch(/proj[\\/]main\.py$/)
    expect(entry.isDirectory).toBe(false)
  })
})
