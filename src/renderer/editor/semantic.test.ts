import { describe, expect, it } from 'vitest'
import { decodeSemanticTokens, mergeTokens, semanticType } from './semantic'
import type { Token } from './tokenizer'

const legend = { tokenTypes: ['variable', 'parameter', 'class', 'function', 'module', 'selfParameter'], tokenModifiers: ['declaration', 'readonly', 'defaultLibrary'] }

describe('decodeSemanticTokens', () => {
  it('turns the relative 5-number groups into tokens by line', () => {
    // line 0: param at 4 (len 1); same line +6: variable readonly (len 3); line 2 col 0: module (len 2)
    const map = decodeSemanticTokens([0, 4, 1, 1, 0, 0, 6, 3, 0, 0b10, 2, 0, 2, 4, 0], legend)
    expect(map.get(0)).toEqual([{ start: 4, end: 5, type: 'sem-parameter' }, { start: 10, end: 13, type: 'sem-constant' }])
    expect(map.get(2)).toEqual([{ start: 0, end: 2, type: 'sem-module' }])
    expect(map.has(1)).toBe(false)
  })
  it('skips unknown types and empty tokens', () => {
    expect(decodeSemanticTokens([0, 0, 3, 99, 0, 0, 4, 0, 0, 0], legend).size).toBe(0)
  })
})

describe('semanticType', () => {
  it('maps types and modifiers to colours', () => {
    expect(semanticType('function', ['defaultLibrary'])).toBe('builtin')
    expect(semanticType('class', [])).toBe('sem-class')
    expect(semanticType('selfParameter', [])).toBe('self')
    expect(semanticType('keyword', [])).toBeNull()
  })
})

describe('mergeTokens', () => {
  const t = (start: number, end: number, type: Token['type']): Token => ({ start, end, type })
  it('semantic tokens replace names but never strings, comments or keywords', () => {
    const syntax = [t(0, 3, 'keyword'), t(4, 7, 'call'), t(8, 15, 'string'), t(16, 20, 'comment')]
    const sem = [{ start: 4, end: 7, type: 'sem-function' as const }, { start: 9, end: 12, type: 'sem-variable' as const }, { start: 0, end: 3, type: 'sem-variable' as const }]
    expect(mergeTokens(syntax, sem)).toEqual([t(0, 3, 'keyword'), t(4, 7, 'sem-function'), t(8, 15, 'string'), t(16, 20, 'comment')])
  })
  it('names the tokenizer left plain get their semantic colour', () => {
    expect(mergeTokens([t(0, 6, 'keyword')], [{ start: 7, end: 10, type: 'sem-parameter' }])).toEqual([t(0, 6, 'keyword'), t(7, 10, 'sem-parameter')])
  })
  it('no semantic tokens: unchanged', () => {
    const syntax = [t(0, 1, 'number')]
    expect(mergeTokens(syntax, undefined)).toBe(syntax)
  })
})
