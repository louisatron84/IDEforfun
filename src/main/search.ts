/**
 * Search across every file in the project (Ctrl+Shift+F).
 * Uses the same options and regex rules as in-file find, skips the folders
 * the file tree hides, binary files and very large files, and stops after a
 * maximum number of results so a too-broad search can't hang the IDE.
 */
import { readFile, stat } from 'node:fs/promises'
import { buildRegExp, type FindOptions } from '../shared/regex'
import { listFiles } from './listFiles'

export interface SearchMatch {
  /** 0-based line and column of the match. */
  line: number
  col: number
  length: number
  /** The line, shortened for display; `start` is where the match begins in `text`. */
  preview: { text: string; start: number }
}

export interface FileResult {
  path: string
  rel: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: FileResult[]
  total: number
  truncated: boolean
  error?: string
}

export interface SearchLimits {
  maxResults?: number
  maxFileBytes?: number
}

const PREVIEW_BEFORE = 40
const PREVIEW_MAX = 120

/** Shorten a line for the results list, keeping the match visible. */
export function makePreview(line: string, col: number, length: number): { text: string; start: number } {
  const indent = /^\s*/.exec(line)![0].length
  let from = Math.min(indent, col)
  let prefix = ''
  if (col - from > PREVIEW_BEFORE) {
    from = col - PREVIEW_BEFORE
    prefix = '…'
  }
  let to = line.length
  let suffix = ''
  if (to - from > PREVIEW_MAX) {
    to = Math.max(col + length, from + PREVIEW_MAX)
    suffix = to < line.length ? '…' : ''
  }
  return { text: prefix + line.slice(from, to) + suffix, start: prefix.length + col - from }
}

/** A file is treated as binary if its first 8 KB contain a NUL byte. */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

export async function searchProject(
  root: string,
  query: string,
  opts: FindOptions,
  limits: SearchLimits = {}
): Promise<SearchResult> {
  const maxResults = limits.maxResults ?? 5000
  const maxFileBytes = limits.maxFileBytes ?? 1_000_000
  const result: SearchResult = { files: [], total: 0, truncated: false }
  if (!query) return result
  const re = buildRegExp(query, opts)
  if (typeof re === 'string') return { ...result, error: re }

  const files = (await listFiles(root)).sort((a, b) => a.rel.localeCompare(b.rel))
  for (const file of files) {
    try {
      if ((await stat(file.path)).size > maxFileBytes) continue
      const buf = await readFile(file.path)
      if (isBinary(buf)) continue
      const lines = buf.toString('utf8').split(/\r\n|\r|\n/)
      const matches: SearchMatch[] = []
      for (let line = 0; line < lines.length; line++) {
        const text = lines[line]
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++
            continue
          }
          matches.push({ line, col: m.index, length: m[0].length, preview: makePreview(text, m.index, m[0].length) })
          result.total++
          if (result.total >= maxResults) break
        }
        if (result.total >= maxResults) break
      }
      if (matches.length > 0) result.files.push({ path: file.path, rel: file.rel, matches })
      if (result.total >= maxResults) {
        result.truncated = true
        break
      }
    } catch {
      // unreadable file (permissions, deleted mid-search): skip it
    }
  }
  return result
}
