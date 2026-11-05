import { describe, expect, it } from 'vitest'
import { pythonCandidates } from './python'

describe('pythonCandidates', () => {
  it('prefers a project virtualenv, then python on PATH (Windows)', () => {
    expect(pythonCandidates('C:\\proj', 'win32')).toEqual([
      'C:\\proj\\.venv\\Scripts\\python.exe',
      'C:\\proj\\venv\\Scripts\\python.exe',
      'C:\\proj\\env\\Scripts\\python.exe',
      'python',
      'py'
    ])
  })
  it('uses bin/python and python3 on macOS/Linux', () => {
    expect(pythonCandidates('/proj', 'linux')).toEqual([
      '/proj/.venv/bin/python',
      '/proj/venv/bin/python',
      '/proj/env/bin/python',
      'python3',
      'python'
    ])
  })
  it('puts a configured interpreter first', () => {
    expect(pythonCandidates('/proj', 'linux', '/usr/bin/python3.12')[0]).toBe('/usr/bin/python3.12')
  })
})
