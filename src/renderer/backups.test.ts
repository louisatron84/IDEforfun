import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupKeeper } from './backups'
import { Doc } from './editor/document'
import type { BackupData } from '../shared/api'

function edit(doc: Doc, text: string) {
  doc.history.transact('typing', { line: 0, col: 0 }, () => doc.buffer.insert({ line: 0, col: 0 }, text))
}

describe('BackupKeeper', () => {
  let written: BackupData[]
  let removed: string[]
  let keeper: BackupKeeper
  beforeEach(() => {
    vi.useFakeTimers()
    written = []
    removed = []
    keeper = new BackupKeeper({
      backupWrite: async (d) => { written.push(d) },
      backupRemove: async (p) => { removed.push(p) }
    }, 1000, () => 42)
  })
  afterEach(() => vi.useRealTimers())

  it('backs up an unsaved file a moment after it changes', async () => {
    const doc = new Doc('/p/a.py', 'x\r\ny')
    keeper.sync([doc])
    await vi.advanceTimersByTimeAsync(2000)
    expect(written).toEqual([]) // nothing unsaved yet
    edit(doc, 'A')
    keeper.sync([doc])
    await vi.advanceTimersByTimeAsync(500)
    expect(written).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    expect(written).toEqual([{ path: '/p/a.py', text: 'Ax\ny', encoding: 'utf8', eol: 'CRLF', time: 42 }])
  })
  it("doesn't rewrite an unchanged backup", async () => {
    const doc = new Doc('/p/a.py', 'x')
    edit(doc, 'A')
    keeper.sync([doc])
    await vi.advanceTimersByTimeAsync(1100)
    keeper.sync([doc])
    await vi.advanceTimersByTimeAsync(1100)
    expect(written.length).toBe(1)
  })
  it('drops the backup when saved, closed or renamed', async () => {
    const a = new Doc('/p/a.py', 'x')
    const b = new Doc('/p/b.py', 'y')
    const c = new Doc('/p/c.py', 'z')
    for (const d of [a, b, c]) edit(d, '!')
    keeper.sync([a, b, c])
    await vi.advanceTimersByTimeAsync(1100)
    a.markSaved()
    c.path = '/p/renamed.py'
    keeper.sync([a, c]) // b closed
    expect(removed.sort()).toEqual(['/p/a.py', '/p/b.py', '/p/c.py'])
    await vi.advanceTimersByTimeAsync(1100)
    expect(written.at(-1)?.path).toBe('/p/renamed.py') // still unsaved under its new name
  })
  it('a file closed before its backup was written is never written', async () => {
    const doc = new Doc('/p/a.py', 'x')
    edit(doc, 'A')
    keeper.sync([doc])
    keeper.sync([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(written).toEqual([])
  })
})
