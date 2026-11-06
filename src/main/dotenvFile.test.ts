import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addEnvToGitignore, envNames, gitignoreHasEnv, processEnv, readDotEnv, setDotEnvValue } from './dotenvFile'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-dotenv-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('.env file', () => {
  it('missing file: nothing set', async () => {
    expect(await readDotEnv(root)).toEqual({})
    expect(await envNames(root)).toEqual([])
  })

  it('set, read, list names (not values)', async () => {
    writeFileSync(join(root, '.env'), '# mine\r\nA=1\r\nEMPTY=\r\n')
    await setDotEnvValue(root, 'GITHUB_TOKEN', 'abc')
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('# mine\r\nA=1\r\nEMPTY=\r\nGITHUB_TOKEN=abc\r\n')
    expect(await readDotEnv(root)).toEqual({ A: '1', EMPTY: '', GITHUB_TOKEN: 'abc' })
    expect(await envNames(root)).toEqual(['A', 'GITHUB_TOKEN'])
  })

  it.skipIf(process.platform === 'win32')('a new .env is readable only by you', async () => {
    await setDotEnvValue(root, 'K', 'v')
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
  })

  it('rejects bad names', async () => {
    await expect(setDotEnvValue(root, 'BAD NAME', 'x')).rejects.toThrow()
    await expect(setDotEnvValue(root, '1X', 'x')).rejects.toThrow()
  })

  it('.gitignore detection and adding', async () => {
    expect(await gitignoreHasEnv(root)).toBe(false)
    for (const line of ['.env', '/.env', '*.env', '.env*']) {
      writeFileSync(join(root, '.gitignore'), `node_modules\n${line}\n`)
      expect(await gitignoreHasEnv(root)).toBe(true)
    }
    writeFileSync(join(root, '.gitignore'), 'node_modules\r\n# .env\r\n.envrc')
    expect(await gitignoreHasEnv(root)).toBe(false)
    await addEnvToGitignore(root)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\r\n# .env\r\n.envrc\r\n.env\r\n')
    expect(await gitignoreHasEnv(root)).toBe(true)
  })

  it('processEnv: the real environment wins over .env, extras win over both', async () => {
    const name = 'FORGE_DOTENV_TEST_VAR'
    writeFileSync(join(root, '.env'), `${name}=file\nFORGE_ONLY_IN_FILE=yes\nPATH=nope\n`)
    const env = await processEnv(root, { EXTRA: '1' })
    expect(env.FORGE_ONLY_IN_FILE).toBe('yes')
    expect(env.PATH ?? env.Path).not.toBe('nope')
    expect(env.EXTRA).toBe('1')
    expect((await processEnv(null)).FORGE_ONLY_IN_FILE).toBeUndefined()
  })
})
