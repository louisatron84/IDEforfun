/**
 * The set of open files (tabs) and which one is active.
 * Pure logic, no DOM, so it can be unit-tested; the TabBar draws it.
 */
import { Doc } from './editor/document'

export interface FileApi {
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
}

/** Compare paths; Windows paths (C:\...) ignore slash direction and case. */
export function samePath(a: string, b: string): boolean {
  const isWin = /^[a-zA-Z]:/.test(a) || /^[a-zA-Z]:/.test(b)
  if (!isWin) return a === b
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

export class Workspace {
  docs: Doc[] = []
  active: Doc | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly api: FileApi,
    /** Ask the user whether unsaved changes in `doc` may be thrown away. */
    private readonly confirmDiscard: (doc: Doc) => boolean
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Call after edits so tabs can update their unsaved markers. */
  notifyChanged(): void {
    for (const l of this.listeners) l()
  }

  find(path: string): Doc | undefined {
    return this.docs.find((d) => samePath(d.path, path))
  }

  /** Open a file in a tab (or switch to it if it's already open). Throws if it can't be read. */
  async open(path: string): Promise<Doc> {
    const existing = this.find(path)
    if (existing) {
      this.activate(existing)
      return existing
    }
    const text = await this.api.readFile(path)
    // It may have been opened while we were reading (double-click).
    const raced = this.find(path)
    if (raced) {
      this.activate(raced)
      return raced
    }
    const doc = new Doc(path, text)
    const at = this.active ? this.docs.indexOf(this.active) + 1 : this.docs.length
    this.docs.splice(at, 0, doc)
    this.activate(doc)
    return doc
  }

  activate(doc: Doc): void {
    this.active = doc
    this.notifyChanged()
  }

  /** Close a tab. Returns false if the user chose to keep unsaved changes. */
  close(doc: Doc): boolean {
    if (doc.dirty && !this.confirmDiscard(doc)) return false
    const index = this.docs.indexOf(doc)
    if (index === -1) return true
    this.docs.splice(index, 1)
    if (this.active === doc) this.active = this.docs[Math.min(index, this.docs.length - 1)] ?? null
    this.notifyChanged()
    return true
  }

  /** Close every tab (e.g. when opening another folder). Returns false if cancelled. */
  closeAll(): boolean {
    for (const doc of this.docs) {
      if (doc.dirty && !this.confirmDiscard(doc)) return false
    }
    this.docs = []
    this.active = null
    this.notifyChanged()
    return true
  }

  async save(doc: Doc | null = this.active): Promise<void> {
    if (!doc) return
    await this.api.writeFile(doc.path, doc.getText())
    doc.markSaved()
    this.notifyChanged()
  }

  /** Switch to the next (+1) or previous (-1) tab, wrapping around. */
  next(delta: 1 | -1): void {
    if (!this.active || this.docs.length < 2) return
    const i = this.docs.indexOf(this.active)
    this.activate(this.docs[(i + delta + this.docs.length) % this.docs.length])
  }

  get anyDirty(): boolean {
    return this.docs.some((d) => d.dirty)
  }
}
