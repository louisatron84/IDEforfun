import { join } from 'node:path'
import type { DirEntry } from '../shared/api'

export const HIDDEN = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'])

export function sortAndFilterEntries(
  dir: string,
  raw: { name: string; isDirectory: boolean }[]
): DirEntry[] {
  return raw
    .filter((r) => !HIDDEN.has(r.name))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    .map((r) => ({ name: r.name, path: join(dir, r.name), isDirectory: r.isDirectory }))
}
