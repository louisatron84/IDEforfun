import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProjectDir } from './projectDir'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-dir-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

describe('prepareProjectDir', () => {
  it('renames a legacy .ideforfun folder to .forge', async () => {
    put('.ideforfun/settings.json', '{"tabSize":2}')
    expect(await prepareProjectDir(root)).toBe('migrated')
    expect(existsSync(join(root, '.forge', 'settings.json'))).toBe(true)
    expect(existsSync(join(root, '.ideforfun'))).toBe(false)
  })

  it('nothing to do when there is no legacy folder', async () => {
    expect(await prepareProjectDir(root)).toBe('none')
    expect(existsSync(join(root, '.forge'))).toBe(false) // not created eagerly
  })

  it('nothing to do when only .forge exists', async () => {
    put('.forge/settings.json', '{}')
    expect(await prepareProjectDir(root)).toBe('none')
  })

  it('uses .forge and leaves .ideforfun alone when both exist', async () => {
    put('.forge/settings.json', '{"tabSize":2}')
    put('.ideforfun/settings.json', '{"tabSize":8}')
    expect(await prepareProjectDir(root)).toBe('both')
    expect(readFileSync(join(root, '.forge', 'settings.json'), 'utf8')).toBe('{"tabSize":2}')
    expect(existsSync(join(root, '.ideforfun', 'settings.json'))).toBe(true)
  })

  it('copies when the rename fails (locked folder) and keeps the original', async () => {
    put('.ideforfun/run.json', '{"configurations":[]}')
    const res = await prepareProjectDir(root, { rename: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }) } })
    expect(res).toBe('copied')
    expect(existsSync(join(root, '.forge', 'run.json'))).toBe(true)
    expect(existsSync(join(root, '.ideforfun', 'run.json'))).toBe(true)
  })

  it('reports an error and leaves no half-copied .forge when the copy fails too', async () => {
    put('.ideforfun/settings.json', '{}')
    put('.ideforfun/run.json', '{}')
    const fail = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
    const res = await prepareProjectDir(root, {
      rename: fail,
      cp: async (from, to) => {
        mkdirSync(to, { recursive: true })
        writeFileSync(join(to, 'settings.json'), '{}') // got partway
        await fail()
      }
    })
    expect(res).toBe('error')
    expect(existsSync(join(root, '.forge'))).toBe(false)
    expect(readdirSync(root).sort()).toEqual(['.ideforfun'])
    expect(existsSync(join(root, '.ideforfun', 'run.json'))).toBe(true)
  })
})

