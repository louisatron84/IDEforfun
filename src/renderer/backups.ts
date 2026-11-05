/**
 * Crash recovery, the window side: keeps a backup of every file with
 * unsaved changes (written a moment after the changes stop), and drops it
 * when the file is saved, closed or its changes are thrown away.
 */
import type { Doc } from './editor/document'
import type { BackupData } from '../shared/api'

export interface BackupApi {
  backupWrite(data: BackupData): Promise<void>
  backupRemove(path: string): Promise<void>
}

/** What a backup of `doc` would contain right now, as a cheap comparison key. */
const stateKey = (doc: Doc) => `${doc.path}|${doc.version}|${doc.eol}|${doc.encoding}`

export class BackupKeeper {
  /** Docs with a backup on disk: the path it was written under, and the state it holds. */
  private readonly written = new Map<Doc, { path: string; key: string }>()
  private readonly timers = new Map<Doc, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly api: BackupApi,
    private readonly delayMs = 1500,
    private readonly now: () => number = Date.now
  ) {}

  /** Call whenever the open files or their state change. */
  sync(openDocs: readonly Doc[]): void {
    // Files closed while their backup was still waiting to be written.
    for (const doc of [...this.timers.keys()]) if (!openDocs.includes(doc)) this.cancel(doc)
    // Drop backups of files that were closed, saved, or renamed.
    for (const [doc, w] of [...this.written]) {
      const open = openDocs.includes(doc)
      if (!open || !doc.dirty || doc.path !== w.path) {
        this.written.delete(doc)
        void this.api.backupRemove(w.path).catch(() => {})
      }
      if (!open) this.cancel(doc)
    }
    // Schedule backups of unsaved files that changed since their last backup.
    for (const doc of openDocs) {
      if (!doc.dirty) {
        this.cancel(doc)
        continue
      }
      if (this.written.get(doc)?.key === stateKey(doc) || this.timers.has(doc)) continue
      this.timers.set(doc, setTimeout(() => {
        this.timers.delete(doc)
        if (!doc.dirty || !openDocs.includes(doc)) return
        void this.write(doc)
      }, this.delayMs))
    }
  }

  private async write(doc: Doc): Promise<void> {
    const key = stateKey(doc)
    const data: BackupData = {
      path: doc.path,
      // Lines joined with \n; the line ending style is kept separately.
      text: doc.buffer.getLines().join('\n'),
      encoding: doc.encoding,
      eol: doc.eol,
      time: this.now()
    }
    try {
      await this.api.backupWrite(data)
      this.written.set(doc, { path: doc.path, key })
    } catch {
      // disk full or similar: try again on the next change
    }
  }

  private cancel(doc: Doc): void {
    const t = this.timers.get(doc)
    if (t !== undefined) clearTimeout(t)
    this.timers.delete(doc)
  }
}
