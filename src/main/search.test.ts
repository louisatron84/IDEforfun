import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchProject, makePreview } from './search'

const opts = (o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }> = {}) =>
  ({ caseSensitive: false, wholeWord: false, regex: false, ...o })

function project() {
  const root = mkdtempSync(join(tmpdir(), 'ideforfun-search-'))
  mkdirSync(join(root, 'pkg'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'main.py'), 'import pkg\nuser = get_user(1)\nprint(user)\n')
  writeFileSync(join(root, 'pkg', 'users.py'), 'def get_user(id):\n    return User(id)\n')
  writeFileSync(join(root, 'node_modules', 'skip.js'), 'get_user')
  writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x67, 0x65, 0x74, 0x5f, 0x75, 0x73, 0x65, 0x72]))
  return root
}

describe('searchProject', () => {
  const root = project()

  it('finds matches in every text file, grouped by file, with line/column', async () => {
    const r = await searchProject(root, 'get_user', opts())
    expect(r.files.map((f) => f.rel)).toEqual(['main.py', 'pkg/users.py'])
    expect(r.files[0].matches).toEqual([{ line: 1, col: 7, length: 8, preview: makePreview('user = get_user(1)', 7, 8) }])
    expect(r.total).toBe(2)
    expect(r.truncated).toBe(false)
  })

  it('skips hidden folders like node_modules and binary files', async () => {
    const r = await searchProject(root, 'get_user', opts())
    expect(r.files.some((f) => f.rel.includes('node_modules') || f.rel.endsWith('.png'))).toBe(false)
  })

  it('respects case sensitivity, whole word and regex', async () => {
    expect((await searchProject(root, 'user', opts({ caseSensitive: true }))).total).toBe(4) // not "User"
    expect((await searchProject(root, 'user', opts({ wholeWord: true }))).total).toBe(3) // user, user, User
    expect((await searchProject(root, 'get_\\w+\\(', opts({ regex: true }))).total).toBe(2)
  })

  it('reports invalid regexes instead of throwing', async () => {
    const r = await searchProject(root, '(', opts({ regex: true }))
    expect(r.error).toBeTruthy()
    expect(r.files).toEqual([])
  })

  it('returns nothing for an empty query', async () => {
    expect((await searchProject(root, '', opts())).files).toEqual([])
  })

  it('stops at the result limit and says so', async () => {
    const r = await searchProject(root, 'u', opts(), { maxResults: 3 })
    expect(r.total).toBe(3)
    expect(r.truncated).toBe(true)
  })

  it('skips files over the size limit', async () => {
    const r = await searchProject(root, 'get_user', opts(), { maxFileBytes: 40 })
    expect(r.files.map((f) => f.rel)).toEqual(['pkg/users.py']) // main.py is 42 bytes, users.py 38
  })
})

describe('makePreview', () => {
  it('trims leading indentation and keeps short lines whole', () => {
    expect(makePreview('    return User(id)', 11, 4)).toEqual({ text: 'return User(id)', start: 7 })
  })
  it('cuts long lines around the match with an ellipsis', () => {
    const line = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200)
    const p = makePreview(line, 200, 6)
    expect(p.text.startsWith('…')).toBe(true)
    expect(p.text.endsWith('…')).toBe(true)
    expect(p.text.slice(p.start, p.start + 6)).toBe('NEEDLE')
    expect(p.text.length).toBeLessThan(140)
  })
})
