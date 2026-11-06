/**
 * Editor behaviour per language: highlighting, the line-comment marker for
 * Ctrl+/, and when Enter should indent one more level. The editor core asks
 * the document's mode instead of assuming Python.
 */
import { languageById, languageForPath, type LanguageInfo } from '../../shared/languages'
import { tokenizeLine, type LineState, type Token } from './tokenizer'
import { tokenizeJson, type JsonState } from './jsonTokenizer'
import { tokenizeConfig, type ConfigSyntax } from './configTokenizer'
import { pythonIndentAfter } from './commands'

export interface LanguageMode {
  language: LanguageInfo
  /** Tokens for one line, given the state at its start ('' at the top of the file). */
  tokenize(text: string, state: string): { tokens: Token[]; endState: string }
  /** For Ctrl+/ (null: the language has no line comments). */
  lineComment: string | null
  /** Should Enter indent one more level after this text (the line up to the cursor)? */
  indentAfter(before: string): boolean
  /** String prefixes like f"..." (Python), for auto-closing quotes after a letter. */
  stringPrefixes: boolean
}

const NO_TOKENS = { tokens: [] as Token[], endState: '' }

const python: LanguageMode = {
  language: languageById('python'),
  tokenize: (text, state) => tokenizeLine(text, state as LineState),
  lineComment: '#',
  indentAfter: pythonIndentAfter,
  stringPrefixes: true
}

/** An opening bracket at the end of the line (Enter right between brackets is handled separately). */
const opensBracket = (before: string) => /[{[(]\s*$/.test(before)

const json: LanguageMode = {
  language: languageById('json'),
  tokenize: (text, state) => tokenizeJson(text, state as JsonState, false),
  lineComment: null,
  indentAfter: opensBracket,
  stringPrefixes: false
}

const jsonc: LanguageMode = {
  ...json,
  language: languageById('jsonc'),
  tokenize: (text, state) => tokenizeJson(text, state as JsonState, true),
  lineComment: '//'
}

function configMode(id: string, syntax: ConfigSyntax): LanguageMode {
  return {
    language: languageById(id),
    tokenize: (text) => ({ tokens: tokenizeConfig(text, syntax), endState: '' }),
    lineComment: syntax.comment[0],
    // YAML: "key:" opens a nested block; TOML/INI: an open bracket (inline tables, lists).
    indentAfter: (before) => opensBracket(before) || (id === 'yaml' && /:\s*$/.test(before.replace(/\s#.*$/, ''))),
    stringPrefixes: false
  }
}

const toml = configMode('toml', { comment: ['#'], separators: ['='] })
const yaml = configMode('yaml', { comment: ['#'], separators: [':'] })
const ini = configMode('ini', { comment: ['#', ';'], separators: ['=', ':'] })

const plainText: LanguageMode = {
  language: languageById('plaintext'),
  tokenize: () => NO_TOKENS,
  lineComment: null,
  indentAfter: () => false,
  stringPrefixes: false
}

const MODES = new Map<string, LanguageMode>([python, json, jsonc, toml, yaml, ini, plainText].map((m) => [m.language.id, m]))

export function modeFor(path: string): LanguageMode {
  return MODES.get(languageForPath(path).id) ?? plainText
}
