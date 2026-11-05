import { describe, expect, it } from 'vitest'
import { splitLines } from './textView'

describe('splitLines', () => {
  it('handles \\n, \\r\\n and \\r line endings', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('an empty file is one empty line', () => {
    expect(splitLines('')).toEqual([''])
  })

  it('a trailing newline gives a final empty line', () => {
    expect(splitLines('x\n')).toEqual(['x', ''])
  })
})
