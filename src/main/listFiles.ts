/** Recursively list a project's files for quick open (Ctrl+P). */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HIDDEN } from './dirEntries'

export interface ProjectFile {
  path: string
  /** Path relative to the project root, with '/' separators. */
  rel: string
}

export async function listFiles(root: string, limit = 20_000): Promise<ProjectFile[]> {
  const out: ProjectFile[] = []
  // Breadth-first, so shallow files are found first if we hit the limit.
  const queue: [string, string][] = [[root, '']]
  while (queue.length > 0 && out.length < limit) {
    const [dir, rel] = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable folder: skip it
    }
    for (const e of entries) {
      if (HIDDEN.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) queue.push([join(dir, e.name), childRel])
      else if (e.isFile()) {
        out.push({ path: join(dir, e.name), rel: childRel })
        if (out.length >= limit) break
      }
    }
  }
  return out
}
