/**
 * Semantic highlighting: the language server says what each name is
 * (parameter, property, class, module, a constant...), which the hand-written
 * tokenizer can't know. Those colours are laid over the tokenizer's: they
 * only replace plain names, never strings, comments, keywords or numbers.
 */
import type { Token } from './tokenizer'

export interface SemToken {
  start: number
  end: number
  /** A CSS class suffix: `tok-${type}`. */
  type: Token['type']
}

export interface Legend {
  tokenTypes: string[]
  tokenModifiers: string[]
}

/** The class for a token type and its modifiers, or null to leave the name as it is. */
export function semanticType(type: string, mods: readonly string[]): Token['type'] | null {
  const has = (m: string) => mods.includes(m)
  switch (type) {
    case 'parameter': return 'sem-parameter'
    case 'selfParameter':
    case 'clsParameter': return 'self'
    case 'variable':
      if (has('readonly')) return 'sem-constant'
      if (has('defaultLibrary') || has('builtin')) return 'builtin'
      return 'sem-variable'
    case 'property': return has('readonly') ? 'sem-constant' : 'sem-property'
    case 'enumMember': return 'sem-constant'
    case 'class':
    case 'type':
    case 'enum':
    case 'interface':
    case 'struct':
    case 'typeParameter': return has('defaultLibrary') || has('builtin') ? 'builtin' : 'sem-class'
    case 'function': return has('defaultLibrary') || has('builtin') ? 'builtin' : 'sem-function'
    case 'method': return 'sem-method'
    case 'namespace':
    case 'module': return 'sem-module'
    case 'decorator': return 'decorator'
    default: return null
  }
}

/** The server's data (5 numbers per token, positions relative to the previous one) as tokens by line. */
export function decodeSemanticTokens(data: readonly number[], legend: Legend): Map<number, SemToken[]> {
  const out = new Map<number, SemToken[]>()
  let line = 0
  let char = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dl = data[i]
    line += dl
    char = dl === 0 ? char + data[i + 1] : data[i + 1]
    const length = data[i + 2]
    const typeName = legend.tokenTypes[data[i + 3]]
    if (!typeName || length <= 0) continue
    const bits = data[i + 4]
    const mods = legend.tokenModifiers.filter((_, k) => bits & (1 << k))
    const type = semanticType(typeName, mods)
    if (!type) continue
    let list = out.get(line)
    if (!list) out.set(line, (list = []))
    list.push({ start: char, end: char + length, type })
  }
  return out
}

/** Tokenizer token types a semantic colour may replace (names); the rest are kept. */
const REPLACEABLE = new Set<string>(['call', 'builtin', 'function', 'class', 'self', 'property'])

/** The tokenizer's tokens with semantic ones laid over plain names. */
export function mergeTokens(syntax: readonly Token[], semantic: readonly SemToken[] | undefined): Token[] {
  if (!semantic?.length) return syntax as Token[]
  const out: Token[] = []
  let s = 0
  const sem = [...semantic].sort((a, b) => a.start - b.start)
  let k = 0
  // Walk both lists in order; a semantic token wins over the names it covers, loses to anything else.
  while (s < syntax.length || k < sem.length) {
    const a = syntax[s]
    const b = sem[k]
    if (!b || (a && a.end <= b.start)) {
      out.push(a)
      s++
      continue
    }
    if (!a || b.end <= a.start) {
      out.push(b)
      k++
      continue
    }
    // They overlap.
    if (!REPLACEABLE.has(a.type) || a.start < b.start || a.end > b.end) {
      // A string, comment, keyword... or a token that only partly overlaps: keep the tokenizer's.
      k++
      continue
    }
    s++ // the semantic token replaces this name (and anything else it covers)
  }
  return out
}
