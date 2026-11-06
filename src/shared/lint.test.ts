import { describe, expect, it } from 'vitest'
import { applyEdit, lineDiff, parseRuffJson } from './lint'

describe('parseRuffJson', () => {
  it('reads problems and their fixes (0-based positions)', () => {
    const json = JSON.stringify([
      {
        code: 'F401', message: '`os` imported but unused', url: 'https://docs.astral.sh/ruff/rules/unused-import',
        location: { row: 1, column: 8 }, end_location: { row: 1, column: 10 },
        fix: { applicability: 'safe', message: 'Remove unused import: `os`', edits: [{ content: '', location: { row: 1, column: 1 }, end_location: { row: 2, column: 1 } }] }
      },
      { code: 'E501', message: 'Line too long', location: { row: 3, column: 89 }, end_location: { row: 3, column: 120 }, fix: null },
      { code: null, message: 'SyntaxError: Expected an expression', location: { row: 5, column: 4 }, end_location: { row: 5, column: 5 } },
      { code: 'X', message: 'bad', location: null }
    ])
    const p = parseRuffJson(json)
    expect(p).toHaveLength(3)
    expect(p[0]).toMatchObject({
      code: 'F401', start: { line: 0, col: 7 }, end: { line: 0, col: 9 },
      fix: { title: 'Remove unused import: `os`', safe: true, edits: [{ start: { line: 0, col: 0 }, end: { line: 1, col: 0 }, text: '' }] }
    })
    expect(p[1].fix).toBeUndefined()
    expect(p[2].code).toBe('syntax')
    expect(parseRuffJson('not json')).toEqual([])
  })
})

describe('lineDiff', () => {
  const check = (a: string, b: string) => {
    const e = lineDiff(a, b)
    expect(e === null ? a : applyEdit(a, e)).toBe(b)
    return e
  }
  it('is null when nothing changed', () => {
    expect(lineDiff('a\nb', 'a\nb')).toBeNull()
  })
  it('touches only the changed lines', () => {
    const e = check('x = 1\ny=2\nz = 3\n', 'x = 1\ny = 2\nz = 3\n')
    expect(e).toEqual({ start: { line: 1, col: 0 }, end: { line: 1, col: 3 }, text: 'y = 2' })
  })
  it('handles inserted and removed lines anywhere', () => {
    check('import b\nimport a\n\nx\n', 'import a\nimport b\n\nx\n')
    check('a\nb\nc\n', 'a\nc\n') // remove a middle line
    check('a\nb\n', 'a\nb\nc\n') // add at the end
    check('a\nb', 'a\nb\nc') // add after a last line without newline
    check('a\nb\nc', 'a') // remove the last lines
    check('a\nb\nc', 'c') // remove the first lines
    check('b\n', 'a\nb\n') // insert at the start
    check('a\nb\n', 'x\ny\nz\n') // replace everything
    check('', 'print(1)\n')
    check('x\n\n\n\ny\n', 'x\n\n\ny\n')
  })
})
