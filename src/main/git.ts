/**
 * Git status for the file tree: which files are modified, new, deleted...
 * Runs `git status` (no shell, fixed arguments) and parses its
 * machine-readable output. If git isn't installed or the folder isn't a
 * repository, there's simply no status.
 */
import { execFile } from 'node:child_process'
import type { GitState, GitStatusMap } from '../shared/api'

export interface PorcelainEntry {
  x: string
  y: string
  path: string
  from?: string
}

/** Parse `git status --porcelain=v1 -z`. */
export function parsePorcelain(out: string): PorcelainEntry[] {
  const parts = out.split('\0')
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.length < 4) continue
    const entry: PorcelainEntry = { x: p[0], y: p[1], path: p.slice(3) }
    if (entry.x === 'R' || entry.x === 'C') entry.from = parts[++i]
    entries.push(entry)
  }
  return entries
}

export function classify(x: string, y: string): GitState {
  const xy = x + y
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict'
  if (xy === '??') return 'untracked'
  if (x === 'A') return 'added'
  if (x === 'R' || x === 'C') return 'renamed'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

/**
 * Turn repo-relative entries into absolute file paths, plus the folders
 * (inside the opened folder) that contain changes, for the dot on folders.
 */
export function buildStatusMap(repoRoot: string, openedFolder: string, entries: PorcelainEntry[]): GitStatusMap {
  const sep = repoRoot.includes('\\') ? '\\' : '/'
  const norm = (p: string) => p.replace(/[\\/]+$/, '')
  const root = norm(repoRoot)
  const opened = norm(openedFolder)
  const lower = (p: string) => (sep === '\\' ? p.toLowerCase() : p)
  const files: Record<string, GitState> = {}
  const folders = new Set<string>()
  for (const e of entries) {
    const abs = root + sep + e.path.replace(/\//g, sep)
    if (!lower(abs).startsWith(lower(opened) + sep)) continue // outside the opened folder
    files[abs] = classify(e.x, e.y)
    let dir = abs.slice(0, abs.lastIndexOf(sep))
    while (dir.length > opened.length && lower(dir).startsWith(lower(opened) + sep)) {
      folders.add(dir)
      dir = dir.slice(0, dir.lastIndexOf(sep))
    }
  }
  return { files, folders: [...folders] }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/** Status for files under `folder`, or null if it's not in a git repo (or git is missing). */
export async function gitStatus(folder: string): Promise<GitStatusMap | null> {
  const top = await git(folder, ['rev-parse', '--show-toplevel'])
  if (top === null) return null
  // git prints the top-level with forward slashes; match the opened folder's style.
  const repoRoot = folder.includes('\\') ? top.trim().replace(/\//g, '\\') : top.trim()
  const out = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (out === null) return null
  return buildStatusMap(repoRoot, folder, parsePorcelain(out))
}
