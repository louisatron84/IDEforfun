/**
 * A hand-written Python tokenizer for syntax highlighting.
 *
 * It works one line at a time. The only thing that can carry over from one
 * line to the next is an open triple-quoted string, so the "state" between
 * lines is just which triple quote we're inside ('' = none).
 *
 * Only interesting pieces get a token; plain text, operators and spaces are
 * left out and drawn in the default color.
 */

export type TokenType =
  | 'keyword'
  | 'constant' // True, False, None
  | 'builtin' // print, len, ...
  | 'self' // self, cls
  | 'function' // name after `def`
  | 'class' // name after `class`
  | 'call' // name followed by `(`
  | 'decorator'
  | 'string'
  | 'number'
  | 'comment'

export interface Token {
  start: number
  end: number
  type: TokenType
}

/** '' = normal code; otherwise we're inside a triple-quoted string with this quote. */
export type LineState = '' | '"""' | "'''"

const KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield'
])

const CONSTANTS = new Set(['True', 'False', 'None', 'NotImplemented', 'Ellipsis', '__debug__'])

const BUILTINS = new Set([
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray',
  'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir',
  'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset',
  'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int',
  'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview',
  'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range',
  'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str',
  'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__',
  // common exceptions
  'BaseException', 'Exception', 'ArithmeticError', 'AssertionError', 'AttributeError',
  'EOFError', 'FileNotFoundError', 'ImportError', 'IndexError', 'KeyError',
  'KeyboardInterrupt', 'LookupError', 'ModuleNotFoundError', 'NameError',
  'NotImplementedError', 'OSError', 'RuntimeError', 'StopIteration', 'SyntaxError',
  'TypeError', 'ValueError', 'ZeroDivisionError'
])

const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y
const STRING_PREFIX = /(?:[rRbBuUfF]{1,2})?(?="""|'''|"|')/y
const DECORATOR = /@[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/uy

function matchAt(re: RegExp, text: string, i: number): string | null {
  re.lastIndex = i
  const m = re.exec(text)
  return m ? m[0] : null
}

/**
 * Find where a string body ends. Starts scanning at `from` (just after the
 * opening quote). Returns the index just after the closing quote, or -1 if
 * the string doesn't close on this line. Backslashes escape the next char.
 */
function findStringEnd(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text.startsWith(quote, i)) return i + quote.length
  }
  return -1
}

export function tokenizeLine(text: string, state: LineState): { tokens: Token[]; endState: LineState } {
  const tokens: Token[] = []
  let i = 0

  // Continue a triple-quoted string from the previous line.
  if (state) {
    const end = findStringEnd(text, 0, state)
    if (end === -1) {
      if (text.length > 0) tokens.push({ start: 0, end: text.length, type: 'string' })
      return { tokens, endState: state }
    }
    tokens.push({ start: 0, end, type: 'string' })
    i = end
  }

  let prevWord = '' // last identifier/keyword seen, to spot names after `def`/`class`
  let afterDot = false // `obj.name`: name is an attribute
  let onlySpaceSoFar = text.slice(0, i).trim() === ''

  while (i < text.length) {
    const ch = text[i]

    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }

    if (ch === '#') {
      tokens.push({ start: i, end: text.length, type: 'comment' })
      break
    }

    // Strings (with optional prefix like f, r, b, rb)
    const prefix = matchAt(STRING_PREFIX, text, i)
    if (prefix !== null) {
      const qStart = i + prefix.length
      const triple = text.startsWith('"""', qStart) ? '"""' : text.startsWith("'''", qStart) ? "'''" : ''
      const quote = triple || text[qStart]
      const end = findStringEnd(text, qStart + quote.length, quote)
      if (end === -1) {
        tokens.push({ start: i, end: text.length, type: 'string' })
        return { tokens, endState: (triple as LineState) || '' }
      }
      tokens.push({ start: i, end, type: 'string' })
      i = end
      prevWord = ''
      onlySpaceSoFar = false
      continue
    }

    // Decorators: only at the start of a line
    if (ch === '@' && onlySpaceSoFar) {
      const dec = matchAt(DECORATOR, text, i)
      if (dec) {
        tokens.push({ start: i, end: i + dec.length, type: 'decorator' })
        i += dec.length
        onlySpaceSoFar = false
        continue
      }
    }

    // Numbers (a leading "." only counts if a digit follows)
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(text[i + 1] ?? ''))) {
      const num = matchAt(NUMBER, text, i)
      if (num) {
        tokens.push({ start: i, end: i + num.length, type: 'number' })
        i += num.length
        prevWord = ''
        onlySpaceSoFar = false
        continue
      }
    }

    // Identifiers and keywords
    const word = matchAt(IDENT, text, i)
    if (word) {
      const end = i + word.length
      const isCall = /^\s*\(/.test(text.slice(end))
      let type: TokenType | null = null
      if (afterDot) type = isCall ? 'call' : null
      else if (prevWord === 'def') type = 'function'
      else if (prevWord === 'class') type = 'class'
      else if (KEYWORDS.has(word)) type = 'keyword'
      else if (CONSTANTS.has(word)) type = 'constant'
      else if (word === 'self' || word === 'cls') type = 'self'
      else if (BUILTINS.has(word)) type = 'builtin'
      else if (isCall) type = 'call'
      if (type) tokens.push({ start: i, end, type })
      prevWord = word
      afterDot = false
      i = end
      onlySpaceSoFar = false
      continue
    }

    // Anything else (operators, brackets, dots...) stays plain.
    i++
    afterDot = ch === '.'
    prevWord = ''
    onlySpaceSoFar = false
  }

  return { tokens, endState: '' }
}
