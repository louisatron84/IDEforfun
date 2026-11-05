import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backups, backupName } from './backups'

describe('Backups', () => {
  let dir: string
  let backups: Backups
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ideforfun-bak-'))
    backups = new Backups(() => join(dir, 'backups'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const data = (path: string, text: string) => ({ path, text, encoding: 'utf8' as const, eol: 'LF' as const, time: 1 })

  it('writes, lists and removes backups', async () => {
    expect(await backups.list()).toEqual([])
    await backups.write(data('C:\\p\\a.py', 'x = 1'))
    await backups.write(data('C:\\p\\b.py', 'y'))
    await backups.write(data('C:\\p\\a.py', 'x = 2')) // replaces the first
    const list = await backups.list()
    expect(list.map((b) => b.text).sort()).toEqual(['x = 2', 'y'])
    await backups.remove('c:/p/A.py')
    expect((await backups.list()).map((b) => b.path)).toEqual(['C:\\p\\b.py'])
  })
  it('skips broken files', async () => {
    await backups.write(data('/p/a.py', 'ok'))
    await writeFile(join(dir, 'backups', 'junk.json'), '{ half')
    expect((await backups.list()).length).toBe(1)
  })
  it('clear removes everything', async () => {
    await backups.write(data('/p/a.py', 'ok'))
    await backups.clear()
    expect(await backups.list()).toEqual([])
  })
  it('names ignore case and slashes on Windows paths', () => {
    expect(backupName('C:\\P\\A.py')).toBe(backupName('c:/p/a.py'))
    expect(backupName('/p/A.py')).not.toBe(backupName('/p/a.py'))
  })
})
