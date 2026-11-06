import { describe, expect, it } from 'vitest'
import { mergeEnv, parseDotEnv, setDotEnvVar } from './dotenv'

const sample = [
  '# keys for the API box',
  '',
  'export A=1',
  'B="x y"',
  "C='z # not a comment'",
  'D=a=b',
  'E=v # note',
  'F="line\\nbreak"',
  'not a variable line',
  ''
].join('\r\n')

describe('.env text', () => {
  it('parses the usual forms', () => {
    expect(parseDotEnv(sample)).toEqual({ A: '1', B: 'x y', C: 'z # not a comment', D: 'a=b', E: 'v', F: 'line\nbreak' })
  })

  it('setDotEnvVar replaces one variable and keeps every other line', () => {
    const out = setDotEnvVar(sample, 'B', 'new')
    expect(out).toBe(sample.replace('B="x y"', 'B=new'))
  })

  it('setDotEnvVar keeps export and appends new variables', () => {
    expect(setDotEnvVar(sample, 'A', '2')).toContain('\r\nexport A=2\r\n')
    expect(setDotEnvVar('X=1\n', 'Y', '2')).toBe('X=1\nY=2\n')
    expect(setDotEnvVar('X=1', 'Y', '2')).toBe('X=1\nY=2\n')
    expect(setDotEnvVar('', 'Y', '2')).toBe('Y=2\n')
  })

  it('setDotEnvVar quotes values that need it', () => {
    expect(setDotEnvVar('', 'K', 'a b')).toBe('K="a b"\n')
    expect(setDotEnvVar('', 'K', 'say "hi"')).toBe('K="say \\"hi\\""\n')
    expect(parseDotEnv(setDotEnvVar('', 'K', 'say "hi" # x'))).toEqual({ K: 'say "hi" # x' })
  })

  it('mergeEnv: the real environment wins', () => {
    expect(mergeEnv({ A: '1', Z: undefined }, { A: '2', B: '3', Z: '4' })).toEqual({ A: '1', B: '3', Z: '4' })
  })
})
