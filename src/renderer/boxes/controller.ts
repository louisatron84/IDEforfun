/**
 * The Connect boxes and their code. Holds the boxes (saved in
 * .forge/boxes.json), and keeps each box's marked block in its Python file
 * up to date: box → code only. A block edited by hand is left alone until
 * the user chooses to overwrite it or keep their edits.
 */
import { moduleOfPath, newApiBox, normalizeBoxes, serializeBoxes, type ApiBox, type BoxesFile } from '../../shared/boxes'
import { blockHash, generateBlock } from '../../shared/boxCode'
import { blockState, findBlock, insertBlock, removeBlock, replaceBlock, withEol } from '../../shared/boxSync'
import { csvPreview, defaultTicks, fieldKey, fieldTree, pickRecords, recordLists, rowsFor, type RecordList } from '../../shared/apiFields'
import type { FieldNode } from '../../shared/boxes'
import type { TestCallResult } from '../../shared/api'

export type BoxState = 'unwritten' | 'ok' | 'edited' | 'missing' | 'broken' | 'detached'

/** Files, relative to the project. */
export interface BoxFiles {
  /** The file's text (an open editor's text if it is open), or null if it doesn't exist. */
  read(rel: string): Promise<string | null>
  /** Change the file (an open editor: one undoable edit, then saved unless it had other unsaved edits). */
  write(rel: string, text: string): Promise<'saved' | 'unsaved' | void>
  saveBoxes(file: BoxesFile): Promise<void>
  /** A short message in the status bar. */
  note(message: string): void
}

/** The box's code as it is now; the block Forge wrote one change earlier also counts as Forge's. */
function codeState(text: string, box: ApiBox): 'ok' | 'edited' | 'missing' | 'broken' {
  const s = blockState(text, box)
  if (s !== 'edited' || !box.prevHash) return s
  const found = findBlock(text, box.id)
  return typeof found === 'object' && blockHash(found.text) === box.prevHash ? 'ok' : 'edited'
}

function leafKeys(tree: readonly FieldNode[], into = new Set<string>()): Set<string> {
  for (const f of tree) {
    if (f.kind === 'object') leafKeys(f.children, into)
    else into.add(fieldKey(f.path))
  }
  return into
}

export class BoxController {
  private list: ApiBox[] = []
  private listeners = new Set<() => void>()
  /** Run one file change at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  /** The CSV last saved for each request (path + text), so it is only written when it changes. */
  private csvSaved = new Map<string, string>()
  selected: string | null = null

  constructor(private readonly files: BoxFiles) {}

  get boxes(): readonly ApiBox[] {
    return this.list
  }

  get(id: string): ApiBox | undefined {
    return this.list.find((b) => b.id === id)
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) fn()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private save(): Promise<void> {
    return this.files.saveBoxes(serializeBoxes(this.list))
  }

  /** Boxes from boxes.json (anything unreadable is dropped). */
  load(raw: unknown): void {
    this.list = normalizeBoxes(raw)
    this.selected = null
    this.changed()
  }

  add(attach: { module: string } | null, target?: { file: string; mode: 'new' | 'append' }): ApiBox {
    const names = new Set(this.list.map((b) => b.name))
    let name = 'API'
    for (let n = 2; names.has(name); n++) name = `API ${n}`
    const box = newApiBox(this.list.map((b) => b.id), name)
    if (target) box.target = target
    // A box in a new file sits beside that file's module once it exists.
    box.attach = attach ?? { module: moduleOfPath(box.target.file) }
    this.list.push(box)
    this.selected = box.id
    void this.save()
    this.changed()
    return box
  }

  select(id: string | null): void {
    this.selected = id && this.get(id) ? id : null
    this.changed()
  }

  /** The block as it would be written now. */
  preview(id: string): string {
    const box = this.get(id)
    return box ? generateBlock(box, { main: box.target.mode === 'new' }) : ''
  }

  async state(id: string): Promise<BoxState> {
    const box = this.get(id)
    if (!box || box.hash === null) return 'unwritten'
    if (box.detached) return 'detached'
    const text = await this.files.read(box.target.file)
    return text === null ? 'missing' : codeState(text, box)
  }

  /** Resolves once every change already asked for has been applied. */
  idle(): Promise<void> {
    return this.queue.then(() => {})
  }

  /** Commit a change made in Box settings: save it and, if the code is Forge's as written, update it. */
  update(id: string, fn: (box: ApiBox) => void): Promise<void> {
    return this.serial(async () => {
      const box = this.get(id)
      if (!box) return
      fn(box)
      await this.save()
      this.changed()
      await this.syncCode(box)
      await this.saveCsv(box)
    })
  }

  /** Save each request's CSV from its last test call (the same file its function writes). */
  private async saveCsv(box: ApiBox): Promise<void> {
    for (const r of box.requests) {
      if (!r.test?.ok || r.test.sample === undefined || !r.ticked.length || !r.output) continue
      const records = pickRecords(r.test.sample, r.recordsPath).records
      const csv = csvPreview(rowsFor(records, r.ticked), r.ticked, Infinity)
      const key = `${box.id}/${r.id}`
      if (this.csvSaved.get(key) === `${r.output}\0${csv}`) continue
      try {
        await this.files.write(r.output, csv)
        this.csvSaved.set(key, `${r.output}\0${csv}`)
        this.files.note(`Saved ${records.length} row${records.length === 1 ? '' : 's'} to ${r.output}`)
      } catch (err) {
        this.files.note(`Couldn't save ${r.output}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private async syncCode(box: ApiBox): Promise<void> {
    if (box.hash === null || box.detached) return
    const text = await this.files.read(box.target.file)
    if (text === null || codeState(text, box) !== 'ok') {
      this.changed()
      return
    }
    const block = this.preview(box.id)
    const hash = blockHash(block)
    if (hash === box.hash) return
    const saved = await this.files.write(box.target.file, replaceBlock(text, box.id, block))
    box.prevHash = box.hash
    box.hash = hash
    await this.save()
    this.files.note(`Updated ${box.target.file} from the ${box.name} box${saved === 'unsaved' ? ' (not saved: the file has other unsaved edits)' : ''}`)
    this.changed()
  }

  /** Write the code (the first time, or again after it was deleted): replaces Forge's block, or adds it at the end. */
  writeCode(id: string): Promise<void> {
    return this.serial(() => this.write(id))
  }

  private async write(id: string): Promise<void> {
    const box = this.get(id)
    if (!box) return
    const block = this.preview(id)
    const text = (await this.files.read(box.target.file)) ?? ''
    const found = findBlock(text, box.id)
    if (found === 'broken') throw new Error(`The forge:box markers for ${box.name} in ${box.target.file} are damaged. Fix or delete them, then try again.`)
    const next = found === 'missing' ? insertBlock(text, block) : text.slice(0, found.start) + withEol(block, text) + text.slice(found.end)
    await this.files.write(box.target.file, next)
    box.prevHash = box.hash
    box.hash = blockHash(block)
    box.detached = false
    await this.save()
    this.changed()
  }

  /** The box's block as it is in the file now (null if it isn't there). */
  async currentBlock(id: string): Promise<string | null> {
    const box = this.get(id)
    const text = box ? await this.files.read(box.target.file) : null
    if (!box || text === null) return null
    const found = findBlock(text, box.id)
    return found === 'missing' || found === 'broken' ? null : found.text
  }

  /** "Overwrite with box": the box's code replaces the hand-edited block. */
  overwrite(id: string): Promise<void> {
    return this.writeCode(id)
  }

  /** "Keep my edits": stop updating this box's code. */
  keepEdits(id: string): Promise<void> {
    return this.update(id, (b) => (b.detached = true))
  }

  /** Remove the box (and, if asked, its code). */
  remove(id: string, removeCode: boolean): Promise<void> {
    return this.serial(async () => {
      const box = this.get(id)
      if (!box) return
      if (removeCode && box.hash !== null) {
        const text = await this.files.read(box.target.file)
        if (text !== null) {
          const next = removeBlock(text, box.id)
          if (next !== text) await this.files.write(box.target.file, next)
        }
      }
      this.list = this.list.filter((b) => b !== box)
      if (this.selected === id) this.selected = null
      await this.save()
      this.changed()
    })
  }

  /** The result of a test call: fields, records and default ticks (the first time). */
  setTest(id: string, requestId: string, result: TestCallResult): Promise<void> {
    return this.update(id, (box) => {
      const req = box.requests.find((r) => r.id === requestId)
      if (!req) return
      const previous = req.test
      if (!result.ok || result.json === undefined) {
        req.test = {
          ...(previous ?? {}),
          ok: false,
          at: Date.now(),
          status: result.status,
          statusText: result.statusText,
          ms: result.ms,
          error: result.error ?? (result.tooBig
            ? 'The response is too big.'
            : result.status !== undefined && (result.status < 200 || result.status >= 300)
              ? `${result.status} ${result.statusText ?? ''}`.trim()
              : result.json === undefined && result.text !== undefined
                ? "The response isn't JSON, so there are no fields to pick."
                : `${result.status ?? ''} ${result.statusText ?? ''}`.trim() || 'The test call failed.')
        }
        return
      }
      const picked = pickRecords(result.json, req.recordsPath)
      const fields = fieldTree(picked.records)
      req.recordsPath = picked.path
      // Keep the ticks that still exist in this response; none left: start from the defaults.
      const keys = leafKeys(fields)
      const kept = req.ticked.filter((k) => keys.has(k))
      req.ticked = kept.length ? kept : defaultTicks(fields)
      req.test = { ok: true, at: Date.now(), status: result.status, statusText: result.statusText, ms: result.ms, count: picked.records.length, fields, sample: result.json }
    })
  }

  /** Where the records come from, chosen from the lists in the last response. */
  setRecordsPath(id: string, requestId: string, path: string[] | null): Promise<void> {
    return this.update(id, (box) => {
      const req = box.requests.find((r) => r.id === requestId)
      if (!req?.test || req.test.sample === undefined) return
      const picked = pickRecords(req.test.sample, path)
      req.recordsPath = picked.path
      req.test.fields = fieldTree(picked.records)
      req.test.count = picked.records.length
      req.ticked = defaultTicks(req.test.fields)
    })
  }

  /** The lists of records in the last response (for "Records from"). */
  recordChoices(id: string, requestId: string): RecordList[] {
    const req = this.get(id)?.requests.find((r) => r.id === requestId)
    return req?.test?.sample === undefined ? [] : recordLists(req.test.sample)
  }
}
