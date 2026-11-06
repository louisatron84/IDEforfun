/**
 * Highlighting for JSON (and JSON with comments). One line at a time, like
 * the Python tokenizer; the only state carried between lines is being inside
 * a block comment.
 */
import type { Token } from './tokenizer'

/** '' = normal; '*' = inside a /* comment *\/ (JSONC only). */
export type JsonState = '' | '*'

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WORD = /[A-Za-z_$][\w$]*/y

export function tokenizeJson(text: string, state: JsonState, comments: boolean): { tokens: Token[]; endState: JsonState } {
  const tokens: Token[] = []
  let i = 0
  if (state === '*') {
    const end = text.indexOf('*/')
    if (end === -1) {
      if (text) tokens.push({ start: 0, end: text.length, type: 'comment' })
      return { tokens, endState: '*' }
    }
    tokens.push({ start: 0, end: end + 2, type: 'comment' })
    i = end + 2
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const end = Math.min(j + 1, text.length)
      // A string followed by ':' is an object key.
      let k = end
      while (text[k] === ' ' || text[k] === '\t') k++
      tokens.push({ start: i, end, type: text[k] === ':' ? 'property' : 'string' })
      i = end
      continue
    }
    if (comments && ch === '/' && text[i + 1] === '/') {
      tokens.push({ start: i, end: text.length, type: 'comment' })
      break
    }
    if (comments && ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) {
        tokens.push({ start: i, end: text.length, type: 'comment' })
        return { tokens, endState: '*' }
      }
      tokens.push({ start: i, end: end + 2, type: 'comment' })
      i = end + 2
      continue
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(text)
      if (m && m[0] !== '-') {
        tokens.push({ start: i, end: i + m[0].length, type: 'number' })
        i += m[0].length
        continue
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      WORD.lastIndex = i
      const w = WORD.exec(text)![0]
      if (w === 'true' || w === 'false' || w === 'null') tokens.push({ start: i, end: i + w.length, type: 'constant' })
      i += w.length
      continue
    }
    i++
  }
  return { tokens, endState: '' }
}
