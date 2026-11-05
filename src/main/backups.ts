/**
 * Backups of unsaved files, so changes survive a crash or power cut.
 * One JSON file per edited file in <userData>/backups, named by a hash of
 * its path. They're removed when the file is saved or its changes are
 * thrown away, so whatever is left at startup came from a crash.
 */
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupData } from '../shared/api'

/** File name for a path's backup (Windows paths ignore case and slash direction). */
export function backupName(path: string): string {
  const norm = /^[a-zA-Z]:/.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path
  return createHash('sha1').update(norm).digest('hex').slice(0, 24) + '.json'
}

export class Backups {
  constructor(private readonly dir: () => string) {}

  async write(data: BackupData): Promise<void> {
    await mkdir(this.dir(), { recursive: true })
    const file = join(this.dir(), backupName(data.path))
    // Write then rename isn't needed: a half-written backup just fails to parse and is skipped.
    await writeFile(file, JSON.stringify(data), 'utf8')
  }

  async remove(path: string): Promise<void> {
    await rm(join(this.dir(), backupName(path)), { force: true })
  }

  async list(): Promise<BackupData[]> {
    let names: string[]
    try {
      names = await readdir(this.dir())
    } catch {
      return []
    }
    const out: BackupData[] = []
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const data = JSON.parse(await readFile(join(this.dir(), name), 'utf8')) as BackupData
        if (typeof data.path === 'string' && typeof data.text === 'string') out.push(data)
      } catch {
        // unreadable or half-written: skip it
      }
    }
    return out
  }

  async clear(): Promise<void> {
    await rm(this.dir(), { recursive: true, force: true })
  }

  /** For when the window is closing right now (an async delete might not finish). */
  clearSync(): void {
    rmSync(this.dir(), { recursive: true, force: true })
  }
}
