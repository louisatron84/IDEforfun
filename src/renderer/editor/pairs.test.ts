import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import { backspacePair, findMatchingBracket, newlineBetweenBrackets, toggleComment, typeChar } from './pairs'

const P = (line: number, col: number) => ({ line, col })
const C = (line: number, col: number) => ({ anchor: P(line, col), head: P(line, col) })

/** Type `ch` at the cursor marked | in `text`; returns the text with | at the new cursor. */
function type(text: string, ch: string): string {
  const lines = text.split('\n')
  const line = lines.findIndex((l) => l.includes('|'))
  const col = lines[line].indexOf('|')
  const b = new TextBuffer(text.replace('|', ''))
  const res = typeChar(b, C(line, col), ch)
  const at = res ? res.head : b.insert(P(line, col), ch)
  const out = b.getText().split('\n')
  out[at.line] = out[at.line].slice(0, at.col) + '|' + out[at.line].slice(at.col)
  return out.join('\n')
}

describe('typeChar', () => {
  it('auto-closes brackets before spaces or the line end', () => {
    expect(type('print|', '(')).toBe('print(|)')
    expect(type('x = |', '[')).toBe('x = [|]')
    expect(type('d = {|}', '{')).toBe('d = {{|}}')
  })
  it("doesn't auto-close right before a word", () => {
    expect(type('|foo', '(')).toBe('(|foo')
  })
  it('types over an existing closer', () => {
    expect(type('print(x|)', ')')).toBe('print(x)|')
    expect(type('s = "abc|"', '"')).toBe('s = "abc"|')
  })
  it('auto-closes quotes, including after string prefixes', () => {
    expect(type('s = |', '"')).toBe('s = "|"')
    expect(type('s = f|', '"')).toBe('s = f"|"')
    expect(type('x = rb|', "'")).toBe("x = rb'|'")
  })
  it('leaves apostrophes alone', () => {
    expect(type('# don|', "'")).toBe("# don'|")
  })
  it('makes docstrings: """|"""', () => {
    expect(type('    ""|', '"')).toBe('    """|"""')
  })
  it('wraps a selection', () => {
    const b = new TextBuffer('x = a + b')
    const res = typeChar(b, { anchor: P(0, 4), head: P(0, 9) }, '(')
    expect(b.getText()).toBe('x = (a + b)')
    expect(res).toEqual({ anchor: P(0, 5), head: P(0, 10) })
  })
  it('ignores other characters', () => {
    expect(typeChar(new TextBuffer(''), C(0, 0), 'a')).toBeNull()
  })
})

describe('backspacePair', () => {
  it('deletes both halves of an empty pair', () => {
    const b = new TextBuffer('f()')
    expect(backspacePair(b, P(0, 2))).toEqual(P(0, 1))
    expect(b.getText()).toBe('f')
    const q = new TextBuffer('""')
    backspacePair(q, P(0, 1))
    expect(q.getText()).toBe('')
  })
  it('does nothing elsewhere', () => {
    expect(backspacePair(new TextBuffer('f(x)'), P(0, 3))).toBeNull()
  })
})

describe('newlineBetweenBrackets', () => {
  it('puts the cursor on an indented line between the brackets', () => {
    const b = new TextBuffer('    x = foo()')
    const at = newlineBetweenBrackets(b, P(0, 12), 4)
    expect(b.getText()).toBe('    x = foo(\n        \n    )')
    expect(at).toEqual(P(1, 8))
  })
  it('only between a matching pair', () => {
    expect(newlineBetweenBrackets(new TextBuffer('foo(x'), P(0, 5), 4)).toBeNull()
  })
})

describe('findMatchingBracket', () => {
  const code = () => true
  it('finds the closer for an opener, across lines and nesting', () => {
    const b = new TextBuffer('f(a, [1, 2],\n  (b))')
    expect(findMatchingBracket(b, P(0, 1), code)).toEqual({ bracket: P(0, 1), match: P(1, 5) })
  })
  it('finds the opener for a closer just before the cursor', () => {
    const b = new TextBuffer('x = [1, (2)]')
    expect(findMatchingBracket(b, P(0, 12), code)).toEqual({ bracket: P(0, 11), match: P(0, 4) })
  })
  it('skips brackets in strings', () => {
    const b = new TextBuffer('f(")", x)')
    const notInString = (_l: number, c: number) => c < 2 || c > 4
    expect(findMatchingBracket(b, P(0, 1), notInString)?.match).toEqual(P(0, 8))
  })
  it('returns null when nothing matches', () => {
    expect(findMatchingBracket(new TextBuffer('f(x'), P(0, 1), code)).toBeNull()
    expect(findMatchingBracket(new TextBuffer('abc'), P(0, 1), code)).toBeNull()
  })
})

describe('toggleComment', () => {
  it('comments lines at their shared indentation', () => {
    const b = new TextBuffer('def f():\n    x = 1\n\n    return x')
    toggleComment(b, { anchor: P(1, 0), head: P(3, 3) })
    expect(b.getText()).toBe('def f():\n    # x = 1\n\n    # return x')
  })
  it('uncomments when every line is commented', () => {
    const b = new TextBuffer('# a\n  #b')
    toggleComment(b, { anchor: P(0, 0), head: P(1, 2) })
    expect(b.getText()).toBe('a\n  b')
  })
  it('keeps the cursor on the same text', () => {
    const b = new TextBuffer('x = 1')
    expect(toggleComment(b, C(0, 4)).head).toEqual(P(0, 6))
    expect(toggleComment(b, C(0, 6)).head).toEqual(P(0, 4))
  })
})
