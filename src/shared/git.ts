/**
 * Reading git's output: `git status --porcelain=v2` (branch + changes),
 * unified diffs (split into hunks you can stage one by one), and branch lists.
 * Pure functions, shared by the main process and the window.
 */

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict' | 'typechange'

export interface FileChange {
  /** Repo-relative, with / separators. */
  path: string
  /** For renames/copies: the old path. */
  from?: string
  kind: ChangeKind
}

export interface RepoStatus {
  branch: string | null
  /** e.g. origin/main, or null if the branch doesn't track one. */
  upstream: string | null
  ahead: number
  behind: number
  /** HEAD is not on a branch (detached) or there are no commits yet. */
  detached: boolean
  /** No commits yet. */
  initial: boolean
  /** The current commit id (null before the first commit). */
  head: string | null
  staged: FileChange[]
  unstaged: FileChange[]
  conflicts: FileChange[]
}

const KIND: Record<string, ChangeKind> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' }

/** Parse `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatusV2(out: string): RepoStatus {
  const s: RepoStatus = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, initial: false, head: null, staged: [], unstaged: [], conflicts: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# ')) {
      const [key, ...rest] = p.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.head') {
        if (val === '(detached)') s.detached = true
        else s.branch = val
      } else if (key === 'branch.oid') {
        if (val === '(initial)') s.initial = true
        else s.head = val
      }
      else if (key === 'branch.upstream') s.upstream = val
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val)
        if (m) {
          s.ahead = Number(m[1])
          s.behind = Number(m[2])
        }
      }
      continue
    }
    const type = p[0]
    if (type === '?') {
      s.unstaged.push({ path: p.slice(2), kind: 'untracked' })
      continue
    }
    if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      s.conflicts.push({ path: fields(p, 10), kind: 'conflict' })
      continue
    }
    if (type !== '1' && type !== '2') continue
    const x = p[2]
    const y = p[3]
    // 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI Xscore path \0 origPath
    const path = fields(p, type === '1' ? 8 : 9)
    const from = type === '2' ? parts[++i] : undefined
    if (x !== '.') s.staged.push({ path, kind: KIND[x] ?? 'modified', ...(from && (x === 'R' || x === 'C') ? { from } : {}) })
    if (y !== '.') s.unstaged.push({ path, kind: KIND[y] ?? 'modified' })
  }
  return s
}

/** Everything after the first `n` space-separated fields (the path may contain spaces). */
function fields(line: string, n: number): string {
  let i = 0
  for (let k = 0; k < n; k++) i = line.indexOf(' ', i) + 1
  return line.slice(i)
}

export interface DiffLine {
  type: ' ' | '+' | '-'
  text: string
  /** 1-based line numbers in the old / new file (null where the line doesn't exist). */
  oldNo: number | null
  newNo: number | null
  /** "\ No newline at end of file" follows this line. */
  noNewline?: boolean
}

export interface Hunk {
  /** The "@@ -a,b +c,d @@ context" line. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  /** The lines before the first hunk (diff --git, index, ---, +++). */
  head: string[]
  oldPath: string | null
  newPath: string | null
  binary: boolean
  hunks: Hunk[]
}

/** Split a unified diff (`git diff`) into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      file = { head: [line], oldPath: null, newPath: null, binary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h) {
      hunk = {
        header: line,
        oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: []
      }
      file.hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }
    if (!hunk) {
      file.head.push(line)
      if (line.startsWith('--- ')) file.oldPath = line === '--- /dev/null' ? null : line.slice(4).replace(/^a\//, '')
      else if (line.startsWith('+++ ')) file.newPath = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '')
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
      continue
    }
    if (line.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }
    const type = line[0] as DiffLine['type']
    if (type === '+') hunk.lines.push({ type, text: line.slice(1), oldNo: null, newNo: newNo++ })
    else if (type === '-') hunk.lines.push({ type, text: line.slice(1), oldNo: oldNo++, newNo: null })
    else hunk.lines.push({ type: ' ', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return files
}

/** A patch with just one hunk of a file (for `git apply` to stage / unstage / discard it). */
export function hunkPatch(file: FileDiff, hunk: Hunk): string {
  const head = file.head
  const body = [hunk.header]
  for (const l of hunk.lines) {
    body.push(l.type + l.text)
    if (l.noNewline) body.push('\\ No newline at end of file')
  }
  return [...head, ...body].join('\n') + '\n'
}

export interface Branch {
  name: string
  current: boolean
  remote: boolean
  upstream: string | null
}

/** Parse `git for-each-ref --format=%(refname)%00%(HEAD)%00%(upstream:short) refs/heads refs/remotes`. */
export function parseBranches(out: string): Branch[] {
  const list: Branch[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue
    const [ref, head, upstream] = line.split('\0')
    if (!ref) continue
    if (ref.startsWith('refs/heads/')) {
      list.push({ name: ref.slice(11), current: head === '*', remote: false, upstream: upstream || null })
    } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
      list.push({ name: ref.slice(13), current: false, remote: true, upstream: null })
    }
  }
  return list
}

/** A branch name git would accept (roughly `git check-ref-format --branch`). */
export function isValidBranchName(name: string): boolean {
  return /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/$)(?!.*\.$)(?!.*\.lock$)[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(name) && !name.startsWith('/') && name !== '@'
}
