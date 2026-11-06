import { describe, expect, it } from 'vitest'
import { languageForPath } from '../../shared/languages'
import { modeFor } from './modes'
import { tokenizeJson } from './jsonTokenizer'
import { tokenizeConfig } from './configTokenizer'
import { Doc } from './document'
import { TextBuffer } from './textBuffer'
import { newline } from './commands'
import { toggleComment, typeChar } from './pairs'

const pieces = (text: string, tokens: { start: number; end: number; type: string }[]) => tokens.map((t) => `${t.type}:${text.slice(t.start, t.end)}`)

describe('languageForPath', () => {
  it('picks the language by extension or file name', () => {
    expect(languageForPath('C:\\proj\\main.py').id).toBe('python')
    expect(languageForPath('/proj/stubs/x.PYI').id).toBe('python')
    expect(languageForPath('/proj/data.json').id).toBe('json')
    expect(languageForPath('/proj/.ideforfun/settings.json').id).toBe('jsonc')
    expect(languageForPath('/proj/pyproject.toml').id).toBe('toml')
    expect(languageForPath('/proj/.github/ci.yml').id).toBe('yaml')
    expect(languageForPath('/proj/setup.cfg').id).toBe('ini')
    expect(languageForPath('/proj/README').id).toBe('plaintext')
    expect(languageForPath('/proj/notes.txt').id).toBe('plaintext')
    expect(languageForPath('/proj/.gitignore').id).toBe('plaintext')
  })

  it('only Python has a language server so far', () => {
    expect(languageForPath('a.py').server).toBe('pyright')
    expect(languageForPath('a.json').server).toBeUndefined()
  })
})

describe('JSON highlighting', () => {
  it('colors keys, strings, numbers and constants', () => {
    const text = '  "name": "x\\"y", "n": -1.5e3, "ok": true, "v": null'
    expect(pieces(text, tokenizeJson(text, '', false).tokens)).toEqual([
      'property:"name"', 'string:"x\\"y"', 'property:"n"', 'number:-1.5e3', 'property:"ok"', 'constant:true', 'property:"v"', 'constant:null'
    ])
  })

  it('JSONC: line and block comments, carried over lines', () => {
    const one = tokenizeJson('{ // note', '', true)
    expect(pieces('{ // note', one.tokens)).toEqual(['comment:// note'])
    const a = tokenizeJson('"a": 1 /* start', '', true)
    expect(a.endState).toBe('*')
    const b = tokenizeJson('still */ "b": 2', a.endState, true)
    expect(pieces('still */ "b": 2', b.tokens)).toEqual(['comment:still */', 'property:"b"', 'number:2'])
    expect(b.endState).toBe('')
    // Plain JSON has no comments.
    expect(tokenizeJson('// x', '', false).tokens).toEqual([])
  })
})

describe('config file highlighting', () => {
  const toml = { comment: ['#'], separators: ['='] }
  const yaml = { comment: ['#'], separators: [':'] }
  it('TOML: sections, keys, strings, numbers, comments', () => {
    expect(pieces('[tool.ruff]  # lint', tokenizeConfig('[tool.ruff]  # lint', toml))).toEqual(['class:[tool.ruff]', 'comment:# lint'])
    const line = 'line-length = 100  # max'
    expect(pieces(line, tokenizeConfig(line, toml))).toEqual(['property:line-length', 'number:100', 'comment:# max'])
    const s = 'name = "demo#1"'
    expect(pieces(s, tokenizeConfig(s, toml))).toEqual(['property:name', 'string:"demo#1"'])
  })

  it('YAML: keys, list items, booleans; a URL is not a key', () => {
    expect(pieces('  - name: build', tokenizeConfig('  - name: build', yaml))).toEqual(['property:name'])
    expect(pieces('debug: true', tokenizeConfig('debug: true', yaml))).toEqual(['property:debug', 'constant:true'])
    expect(pieces('# just a comment', tokenizeConfig('# just a comment', yaml))).toEqual(['comment:# just a comment'])
    expect(pieces('http://x.org', tokenizeConfig('http://x.org', yaml))).toEqual([])
  })
})

describe('editing per language', () => {
  it('Enter indents after ":" in Python, after "{" in JSON, never in plain text', () => {
    const enter = (path: string, text: string) => {
      const b = new TextBuffer(text)
      newline(b, { line: 0, col: text.length }, 4, modeFor(path).indentAfter)
      return b.getLine(1)
    }
    expect(enter('a.py', 'if x:')).toBe('    ')
    expect(enter('a.json', '"a": {')).toBe('    ')
    expect(enter('a.json', '"a": 1,')).toBe('')
    expect(enter('a.txt', 'Note:')).toBe('')
    expect(enter('a.yml', 'jobs:')).toBe('    ')
  })

  it('Ctrl+/ uses the language comment marker', () => {
    const b = new TextBuffer('"a": 1')
    toggleComment(b, { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } }, modeFor('run.json').lineComment!)
    expect(b.getText()).toBe('// "a": 1')
    toggleComment(b, { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } }, '//')
    expect(b.getText()).toBe('"a": 1')
    expect(modeFor('data.json').lineComment).toBeNull()
    expect(modeFor('setup.cfg').lineComment).toBe('#')
  })

  it('docstring quotes and f"" prefixes are Python only', () => {
    const quote = (path: string, text: string) => {
      const b = new TextBuffer(text)
      typeChar(b, { anchor: { line: 0, col: text.length }, head: { line: 0, col: text.length } }, '"', modeFor(path).stringPrefixes)
      return b.getText()
    }
    expect(quote('a.py', 'x = f')).toBe('x = f""')
    expect(quote('a.json', '"a": f')).toBe('"a": f')
  })

  it("a document's mode follows its path (rename)", () => {
    const doc = new Doc('/proj/a.txt', 'x = True')
    expect(doc.mode.language.id).toBe('plaintext')
    expect(doc.highlighter.tokensFor(0)).toEqual([])
    doc.path = '/proj/a.py'
    expect(doc.mode.language.id).toBe('python')
    expect(doc.highlighter.tokensFor(0).map((t) => t.type)).toContain('constant')
  })
})
