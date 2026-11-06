/**
 * Simple highlighting for config files (TOML, YAML, INI/CFG): comments,
 * [section] headers, keys, strings, numbers and true/false. Line by line with
 * no state carried over (multi-line strings are rare in these files).
 */
import type { Token } from './tokenizer'

export interface ConfigSyntax {
  /** Characters that start a comment (at the start of a line or after a space). */
  comment: readonly string[]
  /** Key separators: "=" (TOML, INI) and/or ":" (YAML, INI). */
  separators: readonly string[]
}

const NUMBER = /[-+]?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])/y
const CONSTANTS = new Set(['true', 'false', 'null', 'True', 'False', 'yes', 'no', 'on', 'off', '~'])

export function tokenizeConfig(text: string, syntax: ConfigSyntax): Token[] {
  const tokens: Token[] = []
  const indent = /^\s*/.exec(text)![0].length
  const first = text[indent]
  if (first === undefined) return tokens
  if (syntax.comment.includes(first)) return [{ start: indent, end: text.length, type: 'comment' }]
  // [section] / [[array.of.tables]]
  if (first === '[' && syntax.separators.includes('=')) {
    const close = text.lastIndexOf(']')
    if (close > indent) {
      tokens.push({ start: indent, end: close + 1, type: 'class' })
      const rest = commentAt(text, close + 1, syntax)
      if (rest !== -1) tokens.push({ start: rest, end: text.length, type: 'comment' })
      return tokens
    }
  }
  let i = indent
  // key = / key: (YAML list items start with "- ")
  if (text.startsWith('- ', i)) i += 2
  const key = keyAt(text, i, syntax)
  if (key) {
    tokens.push({ start: i, end: key.end, type: 'property' })
    i = key.sep + 1
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === '\\' ? 2 : 1
      const end = Math.min(j + 1, text.length)
      tokens.push({ start: i, end, type: 'string' })
      i = end
      continue
    }
    if (syntax.comment.includes(ch) && (i === 0 || /\s/.test(text[i - 1]))) {
      tokens.push({ start: i, end: text.length, type: 'comment' })
      break
    }
    const atWordStart = i === 0 || /[\s=:,[{(]/.test(text[i - 1])
    if (atWordStart) {
      NUMBER.lastIndex = i
      const n = NUMBER.exec(text)
      if (n) {
        tokens.push({ start: i, end: i + n[0].length, type: 'number' })
        i += n[0].length
        continue
      }
      const w = /^[\w~]+/.exec(text.slice(i))?.[0]
      if (w) {
        const after = text[i + w.length]
        if (CONSTANTS.has(w) && (after === undefined || /[\s,\]}]/.test(after))) tokens.push({ start: i, end: i + w.length, type: 'constant' })
        i += w.length
        continue
      }
    }
    i++
  }
  return tokens
}

/** A `key =` / `key:` starting at `from`: where the key text ends and where the separator is. */
function keyAt(text: string, from: number, syntax: ConfigSyntax): { end: number; sep: number } | null {
  const m = /^("[^"]*"|'[^']*'|[\w.\-]+(?: [\w.\-]+)*)(\s*)([=:])/.exec(text.slice(from))
  if (!m || !syntax.separators.includes(m[3])) return null
  const end = from + m[1].length
  const sep = end + m[2].length
  // YAML "key:" must be followed by a space or the end ("http://x" is not a key).
  if (m[3] === ':' && !syntax.separators.includes('=') && text[sep + 1] !== undefined && text[sep + 1] !== ' ') return null
  return { end, sep }
}

function commentAt(text: string, from: number, syntax: ConfigSyntax): number {
  for (let i = from; i < text.length; i++) if (syntax.comment.includes(text[i])) return i
  return -1
}
