/**
 * Git commands for the Source Control view: status, diffs, staging (whole
 * files or single hunks via `git apply`), commit, branches, fetch/pull/push.
 * git runs without a shell and with fixed arguments; file paths always come
 * after `--`, so they can't be mistaken for options.
 */
import { spawn } from 'node:child_process'
import type { GitResult } from '../shared/api'
import { isValidBranchName, parseBranches, parseStatusV2, type Branch, type RepoStatus } from '../shared/git'
import { LOG_FORMAT, parseBlame, parseLog, type BlameLine, type Commit } from '../shared/history'

function runGit(cwd: string, args: string[], input?: string, timeout = 120_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        // Never wait for a password on a terminal that isn't there; credential helpers still work.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      })
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (t: string) => (stdout += t))
    child.stderr.on('data', (t: string) => (stderr += t))
    child.stdin.on('error', () => {})
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: err.code === 'ENOENT' ? 'Git is not installed (or not on PATH).' : String(err) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr })
    })
    child.stdin.end(input ?? '')
  })
}

const result = (r: { ok: boolean; stdout: string; stderr: string }): GitResult =>
  r.ok ? { ok: true, output: (r.stdout + r.stderr).trim() } : { ok: false, output: r.stdout.trim(), error: (r.stderr.trim() || r.stdout.trim() || 'git failed').replace(/^(fatal|error): /gm, '') }

/** The repository containing `folder` (its root and status), or null if there isn't one. */
export async function repoStatus(folder: string): Promise<(RepoStatus & { root: string }) | null> {
  const top = await runGit(folder, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const root = folder.includes('\\') ? top.stdout.trim().replace(/\//g, '\\') : top.stdout.trim()
  const st = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  if (!st.ok) return null
  return { root, ...parseStatusV2(st.stdout) }
}

/** The diff of one file: staged (index vs HEAD) or not (working tree vs index). */
export async function fileDiff(root: string, path: string, staged: boolean): Promise<GitResult> {
  const args = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-U3', ...(staged ? ['--cached'] : []), '--', path]
  const r = await runGit(root, args)
  return r.ok ? { ok: true, output: r.stdout } : result(r)
}

export async function stage(root: string, paths: string[]): Promise<GitResult> {
  return result(await runGit(root, ['add', '-A', '--', ...paths]))
}

export async function unstage(root: string, paths: string[]): Promise<GitResult> {
  // No commits yet: there's no HEAD to restore from, so just remove them from the index.
  const head = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!head.ok) return result(await runGit(root, ['rm', '--cached', '-r', '-q', '--', ...paths]))
  return result(await runGit(root, ['restore', '--staged', '--', ...paths]))
}

/** Throw away unstaged changes to tracked files (untracked files are deleted by the window, to the trash). */
export async function discard(root: string, paths: string[]): Promise<GitResult> {
  return result(await runGit(root, ['restore', '--worktree', '--', ...paths]))
}

/**
 * Apply a patch (one hunk): to the index (`cached`: stage it, or unstage it
 * with `reverse`) or to the working tree (`reverse`: discard it).
 */
export async function applyPatch(root: string, patch: string, opts: { cached: boolean; reverse: boolean }): Promise<GitResult> {
  const args = ['apply', '--whitespace=nowarn', ...(opts.cached ? ['--cached'] : []), ...(opts.reverse ? ['--reverse'] : []), '-']
  return result(await runGit(root, args, patch))
}

export async function commit(root: string, message: string, opts: { amend: boolean; all: boolean }): Promise<GitResult> {
  if (opts.all) {
    const added = await runGit(root, ['add', '-A'])
    if (!added.ok) return result(added)
  }
  return result(await runGit(root, ['commit', '-F', '-', ...(opts.amend ? ['--amend'] : [])], message))
}

export async function lastCommitMessage(root: string): Promise<string> {
  const r = await runGit(root, ['log', '-1', '--format=%B'])
  return r.ok ? r.stdout.trimEnd() : ''
}

export async function branches(root: string): Promise<Branch[]> {
  const r = await runGit(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', 'refs/remotes'])
  return r.ok ? parseBranches(r.stdout) : []
}

/** Switch to a branch; a remote one (origin/x) gets a local tracking branch. `create` makes a new one. */
export async function switchBranch(root: string, name: string, opts: { create: boolean; remote: boolean }): Promise<GitResult> {
  if (!isValidBranchName(name)) return { ok: false, output: '', error: `"${name}" isn't a valid branch name.` }
  if (opts.create) return result(await runGit(root, ['switch', '-c', name]))
  if (opts.remote) {
    const local = name.slice(name.indexOf('/') + 1)
    const existing = await runGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${local}`])
    if (existing.ok) return result(await runGit(root, ['switch', local]))
    return result(await runGit(root, ['switch', '--track', name]))
  }
  return result(await runGit(root, ['switch', name]))
}

/** fetch / pull / push. A branch without an upstream is pushed to the first remote and set to track it. */
export async function sync(root: string, action: 'fetch' | 'pull' | 'push'): Promise<GitResult> {
  if (action === 'fetch') return result(await runGit(root, ['fetch', '--prune']))
  if (action === 'pull') return result(await runGit(root, ['pull', '--no-rebase', '--no-edit']))
  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.ok) return result(await runGit(root, ['push']))
  const remotes = (await runGit(root, ['remote'])).stdout.split(/\r?\n/).filter(Boolean)
  if (!remotes.length) return { ok: false, output: '', error: 'This repository has no remote to push to. Add one with: git remote add origin <url>' }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  return result(await runGit(root, ['push', '-u', remote, 'HEAD']))
}

export async function init(folder: string): Promise<GitResult> {
  return result(await runGit(folder, ['init']))
}

// ---------- history and blame ----------

/**
 * Commits, newest first (topological, so the graph draws cleanly). `all`
 * includes every branch; `path` limits it to one file's history (following renames).
 */
export async function log(root: string, opts: { all: boolean; path?: string; limit: number; skip: number }): Promise<{ ok: boolean; commits: Commit[]; error?: string }> {
  const args = ['-c', 'core.quotepath=false', 'log', '--topo-order', `--format=${LOG_FORMAT}`, `-n${Math.min(Math.max(1, opts.limit), 2000)}`, `--skip=${Math.max(0, opts.skip)}`]
  if (opts.all) args.push('--all')
  if (opts.path) args.push('--follow', '--', opts.path)
  const r = await runGit(root, args)
  if (!r.ok) {
    // A repo without commits has no history yet (not an error worth showing).
    if (/does not have any commits|bad default revision/.test(r.stderr)) return { ok: true, commits: [] }
    return { ok: false, commits: [], error: r.stderr.trim() }
  }
  return { ok: true, commits: parseLog(r.stdout) }
}

/** A commit's full message and the files it changed. */
export async function commitDetails(root: string, sha: string): Promise<{ ok: boolean; message: string; files: { path: string; from?: string; status: string }[]; error?: string }> {
  if (!/^[0-9a-f]{4,64}$/.test(sha)) return { ok: false, message: '', files: [], error: 'bad commit id' }
  const r = await runGit(root, ['-c', 'core.quotepath=false', 'show', '--no-color', '--format=%B%x00', '--name-status', '-z', '-M', sha])
  if (!r.ok) return { ok: false, message: '', files: [], error: r.stderr.trim() }
  const nul = r.stdout.indexOf('\0')
  const message = r.stdout.slice(0, nul).trim()
  const parts = r.stdout.slice(nul + 1).replace(/^\s+/, '').split('\0').filter((p) => p !== '')
  const files: { path: string; from?: string; status: string }[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i].trim()
    if (!/^[A-Z]\d*$/.test(status)) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: status[0], from: parts[i + 1], path: parts[i + 2] })
      i += 2
    } else {
      files.push({ status, path: parts[i + 1] })
      i += 1
    }
  }
  return { ok: true, message, files }
}

/** What one commit changed in one file (compared with its first parent). */
export async function commitFileDiff(root: string, sha: string, path: string): Promise<GitResult> {
  if (!/^[0-9a-f]{4,64}$/.test(sha)) return { ok: false, output: '', error: 'bad commit id' }
  const r = await runGit(root, ['-c', 'core.quotepath=false', 'show', '--no-color', '--no-ext-diff', '--format=', '-M', '--first-parent', sha, '--', path])
  return r.ok ? { ok: true, output: r.stdout } : result(r)
}

/** Who last changed each line. `contents` is the editor's text (so unsaved edits line up). */
export async function blame(root: string, path: string, contents?: string): Promise<{ ok: boolean; lines: BlameLine[]; error?: string }> {
  const args = ['blame', '--porcelain', ...(contents !== undefined ? ['--contents', '-'] : []), '--', path]
  const r = await runGit(root, args, contents)
  if (!r.ok) return { ok: false, lines: [], error: r.stderr.trim().replace(/^fatal: /, '') }
  return { ok: true, lines: parseBlame(r.stdout) }
}
