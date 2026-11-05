import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEntry, nameProblem, renameEntry } from './fileOps'

describe('nameProblem', () => {
  it('accepts normal and nested names', () => {
    expect(nameProblem('main.py')).toBeNull()
    expect(nameProblem('.env')).toBeNull()
    expect(nameProblem('pkg/mod.py')).toBeNull()
    expect(nameProblem('pkg\\mod.py')).toBeNull()
  })
  it('rejects empty, odd and unsafe names', () => {
    expect(nameProblem('')).toMatch(/required/)
    expect(nameProblem('   ')).toMatch(/required/)
    expect(nameProblem('ab:c')).toMatch(/can't contain/)
    expect(nameProblem('what?.py')).toMatch(/can't contain/)
    expect(nameProblem('..')).toMatch(/isn't allowed/)
    expect(nameProblem('../outside.py')).toMatch(/isn't allowed/)
    expect(nameProblem('a//b')).toMatch(/empty part/)
    expect(nameProblem('folder/')).toMatch(/empty part/)
    expect(nameProblem('/abs.py')).toMatch(/full path/)
    expect(nameProblem('C:\\x.py')).toMatch(/full path/)
    expect(nameProblem('name.')).toMatch(/end with/)
    expect(nameProblem('CON')).toMatch(/reserved/)
    expect(nameProblem('nul.txt')).toMatch(/reserved/)
  })
  it('can forbid slashes (for rename)', () => {
    expect(nameProblem('a/b', false)).toMatch(/can't contain \//)
  })
})

describe('createEntry / renameEntry', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ideforfun-ops-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates an empty file and returns its path', async () => {
    const p = await createEntry(dir, 'hello.py', false)
    expect(p).toBe(join(dir, 'hello.py'))
    expect(await readFile(p, 'utf8')).toBe('')
  })
  it('creates missing folders for nested names', async () => {
    const p = await createEntry(dir, 'pkg/sub/mod.py', false)
    expect(p).toBe(join(dir, 'pkg', 'sub', 'mod.py'))
    expect((await stat(join(dir, 'pkg', 'sub'))).isDirectory()).toBe(true)
  })
  it('creates folders', async () => {
    const p = await createEntry(dir, 'data', true)
    expect((await stat(p)).isDirectory()).toBe(true)
  })
  it('never overwrites an existing file or folder', async () => {
    await writeFile(join(dir, 'a.py'), 'keep me')
    await expect(createEntry(dir, 'a.py', false)).rejects.toThrow(/already exists/)
    await expect(createEntry(dir, 'a.py', true)).rejects.toThrow(/already exists/)
    expect(await readFile(join(dir, 'a.py'), 'utf8')).toBe('keep me')
  })
  it('rejects bad names', async () => {
    await expect(createEntry(dir, '../escape.py', false)).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })

  it('renames in place', async () => {
    await writeFile(join(dir, 'a.py'), 'x')
    const p = await renameEntry(join(dir, 'a.py'), 'b.py')
    expect(p).toBe(join(dir, 'b.py'))
    expect(await readdir(dir)).toEqual(['b.py'])
  })
  it('refuses to rename onto an existing name', async () => {
    await writeFile(join(dir, 'a.py'), 'a')
    await writeFile(join(dir, 'b.py'), 'b')
    await expect(renameEntry(join(dir, 'a.py'), 'b.py')).rejects.toThrow(/already exists/)
    expect(await readFile(join(dir, 'b.py'), 'utf8')).toBe('b')
  })
  it('refuses to move with a rename', async () => {
    await writeFile(join(dir, 'a.py'), 'a')
    await expect(renameEntry(join(dir, 'a.py'), 'sub/a.py')).rejects.toThrow()
  })
  it.runIf(process.platform === 'win32')('allows a case-only rename on Windows', async () => {
    await writeFile(join(dir, 'a.py'), 'a')
    await renameEntry(join(dir, 'a.py'), 'A.py')
    expect(await readdir(dir)).toEqual(['A.py'])
  })
})
