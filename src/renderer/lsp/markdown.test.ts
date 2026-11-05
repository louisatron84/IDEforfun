import { describe, expect, it } from 'vitest'
import { hoverSections } from './markdown'

describe('hoverSections', () => {
  it('splits Pyright hover markdown into code and text parts', () => {
    const md = '```python\n(function) def greet(name: str) -> str\n```\n---\nSay hello to someone.\n\nArgs: name'
    expect(hoverSections(md)).toEqual([
      { kind: 'code', text: '(function) def greet(name: str) -> str' },
      { text: 'Say hello to someone.\n\nArgs: name' }
    ])
  })
  it('handles plain text without code blocks', () => {
    expect(hoverSections('just text')).toEqual([{ text: 'just text' }])
  })
  it('drops empty parts and horizontal rules', () => {
    expect(hoverSections('```python\nx: int\n```\n\n---\n')).toEqual([{ kind: 'code', text: 'x: int' }])
  })
  it('unescapes markdown escapes in text', () => {
    expect(hoverSections('a\\_b \\*c\\*')).toEqual([{ text: 'a_b *c*' }])
  })
})
