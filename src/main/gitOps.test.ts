import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as git from './gitOps'
import { hunkPatch, parseDiff } from '../shared/git'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'])
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasGit)('git operations on a real repository', () => {
  let dir = ''
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ideforfun-git-'))
    const g = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    g('init', '-q', '-b', 'main')
    g('config', 'user.name', 'Test')
    g('config', 'user.email', 'test@example.com')
    g('config', 'core.autocrlf', 'false')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('sees an empty repo, commits, then reports changes', async () => {
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n')
    let st = await git.repoStatus(dir)
    expect(st).toMatchObject({ branch: 'main', initial: true })
    expect(st!.unstaged).toEqual([{ path: 'a.txt', kind: 'untracked' }])
    const c = await git.commit(dir, 'first', { amend: false, all: true })
    expect(c.ok).toBe(true)
    st = await git.repoStatus(dir)
    expect(st).toMatchObject({ initial: false, staged: [], unstaged: [] })
    expect(await git.lastCommitMessage(dir)).toBe('first')
  })

  it('stages and unstages a single hunk', async () => {
    const changed = [...lines]
    changed[1] = 'CHANGED 2'
    changed[25] = 'CHANGED 26'
    writeFileSync(join(dir, 'a.txt'), changed.join('\n') + '\n')
    const diff = parseDiff((await git.fileDiff(dir, 'a.txt', false)).output)
    expect(diff[0].hunks).toHaveLength(2)

    // Stage only the second hunk.
    const staged = await git.applyPatch(dir, hunkPatch(diff[0], diff[0].hunks[1]), { cached: true, reverse: false })
    expect(staged).toMatchObject({ ok: true })
    const index = parseDiff((await git.fileDiff(dir, 'a.txt', true)).output)
    expect(index[0].hunks).toHaveLength(1)
    expect(index[0].hunks[0].lines.some((l) => l.text === 'CHANGED 26')).toBe(true)
    const work = parseDiff((await git.fileDiff(dir, 'a.txt', false)).output)
    expect(work[0].hunks).toHaveLength(1)
    expect(work[0].hunks[0].lines.some((l) => l.text === 'CHANGED 2')).toBe(true)

    // Unstage it again.
    const un = await git.applyPatch(dir, hunkPatch(index[0], index[0].hunks[0]), { cached: true, reverse: true })
    expect(un.ok).toBe(true)
    expect((await git.fileDiff(dir, 'a.txt', true)).output).toBe('')
  })

  it('discards a single hunk from the working tree', async () => {
    const diff = parseDiff((await git.fileDiff(dir, 'a.txt', false)).output)
    const r = await git.applyPatch(dir, hunkPatch(diff[0], diff[0].hunks[0]), { cached: false, reverse: true })
    expect(r.ok).toBe(true)
    const text = readFileSync(join(dir, 'a.txt'), 'utf8')
    expect(text).toContain('line 2\n')
    expect(text).toContain('CHANGED 26')
  })

  it('stages, unstages and discards whole files', async () => {
    expect((await git.stage(dir, ['a.txt'])).ok).toBe(true)
    expect((await git.repoStatus(dir))!.staged.map((f) => f.path)).toEqual(['a.txt'])
    expect((await git.unstage(dir, ['a.txt'])).ok).toBe(true)
    expect((await git.repoStatus(dir))!.staged).toEqual([])
    expect((await git.discard(dir, ['a.txt'])).ok).toBe(true)
    expect((await git.repoStatus(dir))!.unstaged).toEqual([])
  })

  it('creates and switches branches, and refuses bad names', async () => {
    expect((await git.switchBranch(dir, 'feature/x', { create: true, remote: false })).ok).toBe(true)
    expect((await git.repoStatus(dir))!.branch).toBe('feature/x')
    expect((await git.branches(dir)).map((b) => [b.name, b.current])).toContainEqual(['feature/x', true])
    expect((await git.switchBranch(dir, 'main', { create: false, remote: false })).ok).toBe(true)
    const bad = await git.switchBranch(dir, '--force', { create: true, remote: false })
    expect(bad.ok).toBe(false)
  })

  it('says when there is no remote to push to', async () => {
    const r = await git.sync(dir, 'push')
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/no remote/)
  })
})
