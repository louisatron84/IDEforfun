import { describe, expect, it } from 'vitest'
import { tokenizeLine, type LineState } from './tokenizer'

/** Tokenize and return [text, type] pairs, which are easy to read in test failures. */
function toks(line: string, state: LineState = '') {
  return tokenizeLine(line, state).tokens.map((t) => [line.slice(t.start, t.end), t.type])
}

describe('tokenizeLine', () => {
  it('labels keywords, function names, strings and comments', () => {
    expect(toks('def foo(x="hi"):  # comment')).toEqual([
      ['def', 'keyword'],
      ['foo', 'function'],
      ['"hi"', 'string'],
      ['# comment', 'comment']
    ])
  })

  it('labels class names, self, constants and builtins', () => {
    expect(toks('class Dog(Base):')).toEqual([['class', 'keyword'], ['Dog', 'class']])
    expect(toks('self.x = None or True')).toEqual([
      ['self', 'self'], ['None', 'constant'], ['or', 'keyword'], ['True', 'constant']
    ])
    expect(toks('print(len(items))')).toEqual([['print', 'builtin'], ['len', 'builtin']])
  })

  it('labels calls to your own functions', () => {
    expect(toks('result = compute (a, b)')).toEqual([['compute', 'call']])
  })

  it('treats names after a dot as attributes, not builtins or keywords', () => {
    expect(toks('obj.list + os.open(p) + self.type')).toEqual([
      ['open', 'call'], ['self', 'self']
    ])
  })

  it('labels numbers in their many forms', () => {
    expect(toks('a = 42 + 3.14 + 1_000 + 0xFF + 1e-3 + 2j + .5')).toEqual([
      ['42', 'number'], ['3.14', 'number'], ['1_000', 'number'], ['0xFF', 'number'],
      ['1e-3', 'number'], ['2j', 'number'], ['.5', 'number']
    ])
  })

  it('does not treat digits inside names as numbers', () => {
    expect(toks('x1 = var2')).toEqual([])
  })

  it('handles string prefixes and escaped quotes', () => {
    expect(toks(`f"hi {name}" + rb'\\d' + "say \\"hi\\""`)).toEqual([
      ['f"hi {', 'string'], ['}"', 'string'], [`rb'\\d'`, 'string'], ['"say \\"hi\\""', 'string']
    ])
  })

  it('does not start a comment inside a string', () => {
    expect(toks('url = "a#b"  # real')).toEqual([['"a#b"', 'string'], ['# real', 'comment']])
  })

  it('labels decorators, including dotted ones', () => {
    expect(toks('@app.get("/users")')).toEqual([['@app.get', 'decorator'], ['"/users"', 'string']])
    expect(toks('    @staticmethod')).toEqual([['@staticmethod', 'decorator']])
  })

  it('treats an unterminated single-quoted string as running to the end of the line', () => {
    expect(toks('x = "oops')).toEqual([['"oops', 'string']])
    expect(tokenizeLine('x = "oops', '').endState).toBe('')
  })
})

describe('multi-line (triple-quoted) strings', () => {
  it('a triple-quoted string closed on the same line is one token', () => {
    expect(toks('doc = """hello"""')).toEqual([['"""hello"""', 'string']])
  })

  it('an unclosed triple quote carries state to the next line', () => {
    const first = tokenizeLine('def f():  """Start', '')
    expect(first.endState).toBe('"""')

    const middle = tokenizeLine('  still a docstring # not a comment', '"""')
    expect(middle.tokens).toEqual([{ start: 0, end: 35, type: 'string' }])
    expect(middle.endState).toBe('"""')

    expect(toks('end""" + x', '"""')).toEqual([['end"""', 'string']])
    expect(tokenizeLine('end""" + x', '"""').endState).toBe('')
  })

  it("does not let ''' close a \"\"\" string", () => {
    expect(tokenizeLine("it's ''' here", '"""').endState).toBe('"""')
  })

  it('handles escaped quotes inside a triple-quoted string', () => {
    expect(tokenizeLine('a \\""" b', '"""').endState).toBe('"""')
  })
})

describe('f-strings', () => {
  const parts = (line: string) => tokenizeLine(line, '').tokens.map((t) => [line.slice(t.start, t.end), t.type])
  it('highlights {expressions} as code', () => {
    expect(parts('s = f"hi {name}!"')).toEqual([['f"hi {', 'string'], ['}!"', 'string']])
    expect(parts('f"{len(items)} items"')).toEqual([['f"{', 'string'], ['len', 'builtin'], ['} items"', 'string']])
    expect(parts("f'{x:.2f} {self.y}'")).toEqual([["f'{", 'string'], ['.2', 'number'], ['} {', 'string'], ['self', 'self'], ["}'", 'string']])
  })
  it('{{ and }} are plain text, and normal strings are untouched', () => {
    expect(parts('f"{{literal}}"')).toEqual([['f"{{literal}}"', 'string']])
    expect(parts('"{not code}"')).toEqual([['"{not code}"', 'string']])
  })
  it('strings inside the expression', () => {
    expect(parts(`f"{d['k']}"`)).toEqual([['f"{', 'string'], ["'k'", 'string'], ['}"', 'string']])
  })
})
