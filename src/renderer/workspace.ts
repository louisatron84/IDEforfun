/**
 * The set of open files (tabs) and which one is active.
 * Pure logic, no DOM, so it can be unit-tested; the TabBar draws it.
 */
import { Doc } from './editor/document'
import { LARGE_FILE_BYTES, type Encoding, type TextFileResult } from '../shared/encoding'

export interface FileApi {
  readTextFile(path: string, opts?: { force?: boolean; encoding?: Encoding }): Promise<TextFileResult>
  writeTextFile(path: string, text: string, encoding: Encoding): Promise<void>
}

/** Opening was refused: the file looks binary, is huge (both can be forced), or is too large. */
export class OpenRefused extends Error {
  constructor(readonly reason: 'binary' | 'huge' | 'tooLarge', readonly size: number) {
    super(reason === 'binary' ? 'This looks like a binary file' : `The file is too large (${(size / 1048576).toFixed(0)} MB)`)
  }
}

async function readDoc(api: FileApi, path: string, opts: { force?: boolean; encoding?: Encoding }): Promise<Doc> {
  const res = await api.readTextFile(path, opts)
  if (res.kind !== 'text') throw new OpenRefused(res.kind, res.size)
  return new Doc(path, res.text, { encoding: res.encoding, large: res.size > LARGE_FILE_BYTES })
}

/** Compare paths; Windows paths (C:\...) ignore slash direction and case. */
export function samePath(a: string, b: string): boolean {
  const isWin = /^[a-zA-Z]:/.test(a) || /^[a-zA-Z]:/.test(b)
  if (!isWin) return a === b
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

/** True if `path` is `parent` itself or somewhere inside it. */
export function isInside(path: string, parent: string): boolean {
  if (samePath(path, parent)) return true
  const isWin = /^[a-zA-Z]:/.test(path) || /^[a-zA-Z]:/.test(parent)
  const norm = (p: string) => (isWin ? p.replace(/\//g, '\\').toLowerCase() : p)
  const sep = isWin ? '\\' : '/'
  const base = norm(parent)
  return norm(path).startsWith(base.endsWith(sep) ? base : base + sep)
}

/** One row of tabs with its own active tab (the editor area can be split into two). */
export interface Group {
  docs: Doc[]
  active: Doc | null
}

export class Workspace {
  /** Tab groups, left to right. There's always at least one. */
  groups: Group[] = [{ docs: [], active: null }]
  /** The group with keyboard focus: commands and "the active file" refer to it. */
  activeGroup = 0
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

  private get group(): Group {
    return this.groups[this.activeGroup]
  }

  /** Every open file once (a file open in both groups is one Doc). */
  get docs(): Doc[] {
    const all: Doc[] = []
    for (const g of this.groups) for (const d of g.docs) if (!all.includes(d)) all.push(d)
    return all
  }

  /** The active file of the focused group. */
  get active(): Doc | null {
    return this.group.active
  }

  find(path: string): Doc | undefined {
    return this.docs.find((d) => samePath(d.path, path))
  }

  /**
   * Open a file in a tab of the focused group (or switch to it). Throws if it
   * can't be read, or OpenRefused for binary/huge files unless `force`.
   */
  open(path: string, opts: { force?: boolean } = {}): Promise<Doc> {
    // One at a time: opening several files quickly keeps their tabs in the order asked.
    const next = this.opening.then(() => this.openNow(path, opts))
    this.opening = next.catch(() => {})
    return next
  }

  private opening: Promise<unknown> = Promise.resolve()

  private async openNow(path: string, opts: { force?: boolean }): Promise<Doc> {
    const existing = this.find(path)
    if (existing) {
      this.show(existing)
      return existing
    }
    const doc = await readDoc(this.api, path, opts)
    // It may have been opened while we were reading (double-click).
    const raced = this.find(path)
    if (raced) {
      this.show(raced)
      return raced
    }
    this.show(doc)
    return doc
  }

  /**
   * Bring back a saved layout: tabs per group, each group's active tab and
   * the focused group. Files that can't be opened any more (deleted, now
   * binary or huge) are skipped and returned. Expects no tabs open.
   */
  async restore(layout: { paths: string[]; active: string | null }[], activeGroup: number): Promise<{ opened: Doc[][]; skipped: string[] }> {
    const skipped: string[] = []
    const byPath = new Map<string, Doc>()
    const groups: Group[] = []
    for (const g of layout.slice(0, 2)) {
      const docs: Doc[] = []
      for (const path of g.paths) {
        let doc = [...byPath.values()].find((d) => samePath(d.path, path)) ?? this.find(path)
        if (!doc) {
          try {
            doc = await readDoc(this.api, path, {})
          } catch {
            skipped.push(path)
            continue
          }
          byPath.set(path, doc)
        }
        if (!docs.includes(doc)) docs.push(doc)
      }
      const active = docs.find((d) => g.active !== null && samePath(d.path, g.active)) ?? docs[0] ?? null
      groups.push({ docs, active })
    }
    // A side whose files are all gone isn't worth keeping.
    const focused = groups[activeGroup]
    const kept = groups.filter((g) => g.docs.length)
    if (!kept.length) kept.push({ docs: [], active: null })
    this.groups = kept
    this.activeGroup = Math.max(0, kept.indexOf(focused!))
    this.notifyChanged()
    return { opened: groups.map((g) => g.docs), skipped }
  }

  /** Read the file again with another encoding, replacing its tabs' contents. */
  async reopenWithEncoding(doc: Doc, encoding: Encoding): Promise<Doc> {
    const fresh = await readDoc(this.api, doc.path, { force: true, encoding })
    fresh.folds = []
    for (const g of this.groups) {
      const i = g.docs.indexOf(doc)
      if (i !== -1) g.docs[i] = fresh
      if (g.active === doc) g.active = fresh
    }
    this.notifyChanged()
    return fresh
  }

  /** Show a doc in the focused group, adding a tab next to the current one if needed. */
  private show(doc: Doc): void {
    const g = this.group
    if (!g.docs.includes(doc)) {
      const at = g.active ? g.docs.indexOf(g.active) + 1 : g.docs.length
      g.docs.splice(at, 0, doc)
    }
    g.active = doc
    this.notifyChanged()
  }

  /** Make `doc` active: in the focused group if it has a tab there, else in the group that has it. */
  activate(doc: Doc, groupIndex?: number): void {
    const i = groupIndex ?? (this.group.docs.includes(doc) ? this.activeGroup : this.groups.findIndex((g) => g.docs.includes(doc)))
    if (i === -1 || !this.groups[i]) return
    this.activeGroup = i
    const g = this.groups[i]
    if (!g.docs.includes(doc)) g.docs.push(doc)
    g.active = doc
    this.notifyChanged()
  }

  /** Give keyboard focus to a group (e.g. its editor was clicked). */
  focusGroup(index: number): void {
    if (index === this.activeGroup || !this.groups[index]) return
    this.activeGroup = index
    this.notifyChanged()
  }

  /** Split: open the active file in a second group (or move to the other group if already split). */
  split(): void {
    if (this.groups.length > 1) {
      this.focusGroup(this.activeGroup === 0 ? 1 : 0)
      return
    }
    const doc = this.active
    this.groups.push({ docs: doc ? [doc] : [], active: doc })
    this.activeGroup = 1
    this.notifyChanged()
  }

  /** Move the active tab to the other group (splitting first if needed). */
  moveToOtherGroup(): void {
    const doc = this.active
    if (!doc) return
    if (this.groups.length === 1) {
      this.split()
      this.removeFrom(0, doc)
    } else {
      const from = this.activeGroup
      const to = from === 0 ? 1 : 0
      const target = this.groups[to]
      if (!target.docs.includes(doc)) target.docs.push(doc)
      target.active = doc
      this.removeFrom(from, doc)
      this.activeGroup = Math.min(to, this.groups.length - 1)
    }
    this.notifyChanged()
  }

  /** Close a tab (in the focused group, or `groupIndex`). Returns false if the user kept unsaved changes. */
  close(doc: Doc, groupIndex?: number): boolean {
    const i = groupIndex ?? (this.group.docs.includes(doc) ? this.activeGroup : this.groups.findIndex((g) => g.docs.includes(doc)))
    if (i === -1) return true
    const elsewhere = this.groups.some((g, j) => j !== i && g.docs.includes(doc))
    // Unsaved changes are only lost when the last tab showing the file closes.
    if (!elsewhere && doc.dirty && !this.confirmDiscard(doc)) return false
    this.removeFrom(i, doc)
    this.notifyChanged()
    return true
  }

  /** Remove a tab from a group; an emptied second group goes away. */
  private removeFrom(groupIndex: number, doc: Doc): void {
    const g = this.groups[groupIndex]
    const index = g.docs.indexOf(doc)
    if (index === -1) return
    g.docs.splice(index, 1)
    if (g.active === doc) g.active = g.docs[Math.min(index, g.docs.length - 1)] ?? null
    if (!g.docs.length && this.groups.length > 1) {
      this.groups.splice(groupIndex, 1)
      if (this.activeGroup >= this.groups.length || this.activeGroup === groupIndex) {
        this.activeGroup = Math.max(0, Math.min(groupIndex, this.groups.length - 1))
      }
    }
  }

  /** Close every tab (e.g. when opening another folder). Returns false if cancelled. */
  closeAll(): boolean {
    for (const doc of this.docs) {
      if (doc.dirty && !this.confirmDiscard(doc)) return false
    }
    this.groups = [{ docs: [], active: null }]
    this.activeGroup = 0
    this.notifyChanged()
    return true
  }

  async save(doc: Doc | null = this.active): Promise<void> {
    if (!doc) return
    await this.api.writeTextFile(doc.path, doc.getText(), doc.encoding)
    doc.markSaved()
    this.notifyChanged()
  }

  /** Switch to the next (+1) or previous (-1) tab in the focused group, wrapping around. */
  next(delta: 1 | -1): void {
    const g = this.group
    if (!g.active || g.docs.length < 2) return
    const i = g.docs.indexOf(g.active)
    this.activate(g.docs[(i + delta + g.docs.length) % g.docs.length], this.activeGroup)
  }

  /** Open docs for this file, or for files inside this folder. */
  docsUnder(path: string): Doc[] {
    return this.docs.filter((d) => isInside(d.path, path))
  }

  /** A file or folder was renamed on disk: point the affected tabs at the new paths. */
  pathRenamed(oldPath: string, newPath: string): Doc[] {
    const moved = this.docsUnder(oldPath)
    for (const doc of moved) doc.path = newPath + doc.path.slice(oldPath.length)
    if (moved.length) this.notifyChanged()
    return moved
  }

  /** Close tabs without asking (their files were deleted). */
  discard(docs: Doc[]): void {
    if (!docs.length) return
    for (let i = this.groups.length - 1; i >= 0; i--) {
      for (const doc of docs) this.removeFrom(i, doc)
    }
    this.notifyChanged()
  }

  get anyDirty(): boolean {
    return this.docs.some((d) => d.dirty)
  }
}
