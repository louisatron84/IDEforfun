/**
 * Git history and blame: parsing `git log` / `git blame --porcelain`, and
 * laying out the commit graph (which column each commit goes in and which
 * lines connect it to its parents).
 */

export interface Commit {
  sha: string
  parents: string[]
  author: string
  /** Seconds since 1970. */
  time: number
  /** Branch / tag names pointing here ("HEAD -> main, origin/main, tag: v1"). */
  refs: string[]
  subject: string
}

/** The --format used with parseLog: fields separated by NUL, commits by RS (\x1e). */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e'

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\s+/, '')
    if (!r) continue
    const [sha, parents, author, time, refs, subject] = r.split('\0')
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) continue
    commits.push({
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '',
      time: Number(time) || 0,
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      subject: subject ?? ''
    })
  }
  return commits
}

export interface GraphRow {
  /** Column of this commit's dot. */
  col: number
  /** Which commit each column expects next, entering this row (null = empty column). */
  before: (string | null)[]
  /** ...and leaving it (towards older commits). */
  after: (string | null)[]
  /** Columns that end at this commit (branches that were merged into it from above). */
  joins: number[]
  /** Columns of this commit's parents in `after`. */
  parentCols: number[]
}

/**
 * Lay out the graph for commits listed newest first (as `git log --topo-order`
 * gives them). Each row says where the dot is and how lines continue.
 */
export function graphLayout(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  const free = (avoid: number) => {
    const i = lanes.findIndex((l, k) => l === null && k !== avoid)
    return i === -1 ? lanes.length : i
  }
  for (const c of commits) {
    let col = lanes.indexOf(c.sha)
    if (col === -1) {
      col = free(-1)
      lanes[col] = c.sha
    }
    const before = lanes.slice()
    const joins: number[] = []
    for (let i = 0; i < lanes.length; i++) {
      if (i !== col && lanes[i] === c.sha) {
        joins.push(i)
        lanes[i] = null
      }
    }
    const parentCols: number[] = []
    if (!c.parents.length) lanes[col] = null
    else {
      lanes[col] = c.parents[0]
      parentCols.push(col)
      for (const p of c.parents.slice(1)) {
        let pc = lanes.indexOf(p)
        if (pc === -1) {
          pc = free(col)
          lanes[pc] = p
        }
        parentCols.push(pc)
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ col, before, after: lanes.slice(), joins, parentCols })
  }
  return rows
}

export interface BlameLine {
  sha: string
  author: string
  time: number
  summary: string
  /** Not committed yet (sha of zeros). */
  uncommitted: boolean
}

/** `git blame --porcelain` → one entry per line of the file (index = line). */
export function parseBlame(out: string): BlameLine[] {
  const info = new Map<string, { author: string; time: number; summary: string }>()
  const lines: BlameLine[] = []
  let sha = ''
  let finalLine = 0
  for (const raw of out.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (header) {
      sha = header[1]
      finalLine = Number(header[2]) - 1
      if (!info.has(sha)) info.set(sha, { author: '', time: 0, summary: '' })
      continue
    }
    if (line.startsWith('\t')) {
      const i = info.get(sha)!
      lines[finalLine] = { sha, ...i, uncommitted: /^0+$/.test(sha) }
      continue
    }
    const meta = info.get(sha)
    if (!meta) continue
    if (line.startsWith('author ')) meta.author = line.slice(7)
    else if (line.startsWith('author-time ')) meta.time = Number(line.slice(12)) || 0
    else if (line.startsWith('summary ')) meta.summary = line.slice(8)
  }
  // Fill any gap (shouldn't happen) so indexes line up with the file.
  for (let i = 0; i < lines.length; i++) lines[i] ??= { sha: '', author: '', time: 0, summary: '', uncommitted: true }
  return lines
}

/** "3 days ago", "2 months ago", "just now". */
export function timeAgo(seconds: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - seconds))
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [size, name] of units) {
    const n = Math.floor(s / size)
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`
  }
  return 'just now'
}
