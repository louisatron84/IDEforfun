import { describe, expect, it } from 'vitest'
import type { BoxesFile } from '../../shared/boxes'
import { BoxController, type BoxFiles } from './controller'

function memory(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const notes: string[] = []
  const saved: BoxesFile[] = []
  const io: BoxFiles = {
    read: async (rel) => files.get(rel) ?? null,
    write: async (rel, text) => void files.set(rel, text),
    saveBoxes: async (file) => void saved.push(JSON.parse(JSON.stringify(file))),
    note: (m) => void notes.push(m)
  }
  return { files, notes, saved, io }
}

const RESPONSE = { items: [{ a: 1, b: { c: 'x' } }, { a: 2 }], total: 2 }

async function written() {
  const m = memory()
  const ctrl = new BoxController(m.io)
  const box = ctrl.add({ module: 'app' })
  await ctrl.update(box.id, (b) => {
    b.name = 'GitHub'
    b.target = { file: 'api/github.py', mode: 'new' }
    b.requests[0].url = 'https://api.github.com/users'
  })
  await ctrl.writeCode(box.id)
  return { m, ctrl, id: box.id }
}

describe('BoxController', () => {
  it('add: a new box, selected and saved', () => {
    const m = memory()
    const ctrl = new BoxController(m.io)
    let changes = 0
    ctrl.onChange(() => changes++)
    const box = ctrl.add({ module: 'app' })
    expect(ctrl.boxes).toHaveLength(1)
    expect(ctrl.selected).toBe(box.id)
    expect(box.attach).toEqual({ module: 'app' })
    expect(changes).toBeGreaterThan(0)
    expect(ctrl.add(null).name).toBe('API 2')
  })

  it('nothing is written before Write code', async () => {
    const m = memory()
    const ctrl = new BoxController(m.io)
    const box = ctrl.add(null)
    await ctrl.update(box.id, (b) => (b.requests[0].url = 'https://x.org/a'))
    expect(m.files.size).toBe(0)
    expect(await ctrl.state(box.id)).toBe('unwritten')
    expect(ctrl.preview(box.id)).toContain('def api_data(')
  })

  it('writeCode creates the file and remembers the hash', async () => {
    const { m, ctrl, id } = await written()
    const text = m.files.get('api/github.py')!
    expect(text).toContain(`# forge:box ${id}`)
    expect(text).toContain('if __name__ == "__main__":')
    expect(await ctrl.state(id)).toBe('ok')
    expect(m.saved.at(-1)!.boxes[0].hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('appending to an existing file keeps its text and has no __main__ of its own', async () => {
    const m = memory({ 'app.py': 'import os\r\nprint(1)\r\n' })
    const ctrl = new BoxController(m.io)
    const box = ctrl.add({ module: 'app' }, { file: 'app.py', mode: 'append' })
    await ctrl.writeCode(box.id)
    const text = m.files.get('app.py')!
    expect(text.startsWith('import os\r\nprint(1)\r\n\r\n# forge:box')).toBe(true)
    expect(text).not.toContain('__main__')
    expect(text).not.toMatch(/[^\r]\n/)
  })

  it('a change rewrites only the block, and says so', async () => {
    const { m, ctrl, id } = await written()
    m.files.set('api/github.py', 'x = 0\n\n' + m.files.get('api/github.py')! + '\nprint("mine")\n')
    await ctrl.update(id, (b) => (b.requests[0].name = 'users'))
    const text = m.files.get('api/github.py')!
    expect(text).toContain('def github_users(')
    expect(text.startsWith('x = 0\n\n# forge:box')).toBe(true)
    expect(text.endsWith('\nprint("mine")\n')).toBe(true)
    expect(m.notes.at(-1)).toBe('Updated api/github.py from the GitHub box')
  })

  it('a hand edit stops automatic rewrites', async () => {
    const { m, ctrl, id } = await written()
    const edited = m.files.get('api/github.py')!.replace('return rows', 'return rows[:10]')
    m.files.set('api/github.py', edited)
    await ctrl.update(id, (b) => (b.requests[0].name = 'users'))
    expect(m.files.get('api/github.py')).toBe(edited)
    expect(await ctrl.state(id)).toBe('edited')
  })

  it('keep my edits detaches; overwrite writes the box again', async () => {
    const { m, ctrl, id } = await written()
    const edited = m.files.get('api/github.py')!.replace('return rows', 'return rows[:10]')
    m.files.set('api/github.py', edited)
    await ctrl.keepEdits(id)
    expect(await ctrl.state(id)).toBe('detached')
    await ctrl.update(id, (b) => (b.requests[0].name = 'users'))
    expect(m.files.get('api/github.py')).toBe(edited)
    await ctrl.overwrite(id)
    expect(m.files.get('api/github.py')).toContain('def github_users(')
    expect(m.files.get('api/github.py')).not.toContain('rows[:10]')
    expect(await ctrl.state(id)).toBe('ok')
  })

  it('a deleted block is missing; writeCode puts it back', async () => {
    const { m, ctrl, id } = await written()
    m.files.set('api/github.py', 'print("left")\n')
    expect(await ctrl.state(id)).toBe('missing')
    await ctrl.update(id, (b) => (b.requests[0].name = 'users'))
    expect(m.files.get('api/github.py')).toBe('print("left")\n')
    await ctrl.writeCode(id)
    expect(m.files.get('api/github.py')).toContain('def github_users(')
  })

  it('remove, with or without the code', async () => {
    const { m, ctrl, id } = await written()
    m.files.set('api/github.py', 'x = 0\n' + '\n' + m.files.get('api/github.py')!)
    await ctrl.remove(id, true)
    expect(m.files.get('api/github.py')).toBe('x = 0\n')
    expect(ctrl.boxes).toHaveLength(0)
    expect(ctrl.selected).toBeNull()
    expect(m.saved.at(-1)!.boxes).toEqual([])
  })

  it('setTest: fields, default ticks once, the records path, no samples saved', async () => {
    const { m, ctrl, id } = await written()
    const req = ctrl.get(id)!.requests[0]
    await ctrl.setTest(id, req.id, { ok: true, status: 200, statusText: 'OK', ms: 120, json: RESPONSE })
    const after = ctrl.get(id)!.requests[0]
    expect(after.ticked).toEqual(['a'])
    expect(after.recordsPath).toEqual(['items'])
    expect(after.test).toMatchObject({ ok: true, status: 200, count: 2, ms: 120 })
    expect(after.test!.fields!.map((f) => f.name)).toEqual(['a', 'b'])
    expect(m.files.get('api/github.py')).toContain('fields = ["a"]')
    await ctrl.update(id, (b) => (b.requests[0].ticked = ['a', 'b.c']))
    await ctrl.setTest(id, req.id, { ok: true, status: 200, ms: 90, json: RESPONSE })
    expect(ctrl.get(id)!.requests[0].ticked).toEqual(['a', 'b.c'])
    expect(JSON.stringify(m.saved.at(-1))).not.toContain('"total"')
  })

  it('a successful test call saves the CSV, and ticking fields updates it', async () => {
    const { m, ctrl, id } = await written()
    const req = ctrl.get(id)!.requests[0]
    await ctrl.setTest(id, req.id, { ok: true, status: 200, ms: 1, json: RESPONSE })
    expect(m.files.get(req.output)).toBe('a\r\n1\r\n2\r\n')
    expect(m.notes.at(-1)).toBe(`Saved 2 rows to ${req.output}`)
    await ctrl.update(id, (b) => (b.requests[0].ticked = ['a', 'b.c']))
    expect(m.files.get(req.output)).toBe('a,b.c\r\n1,x\r\n2,\r\n')
  })

  it('no CSV without a successful test call or with nothing ticked', async () => {
    const m = memory()
    const ctrl = new BoxController(m.io)
    const box = ctrl.add(null)
    const req = box.requests[0]
    await ctrl.setTest(box.id, req.id, { ok: false, ms: 1, error: 'nope' })
    expect(m.files.has(req.output)).toBe(false)
    await ctrl.setTest(box.id, req.id, { ok: true, ms: 1, json: RESPONSE })
    await ctrl.update(box.id, (b) => (b.requests[0].ticked = []))
    const before = m.files.get(req.output)
    await ctrl.update(box.id, (b) => (b.baseUrl = 'https://x.org'))
    expect(m.files.get(req.output)).toBe(before)
  })

  it('setTest with an error keeps the old fields', async () => {
    const { ctrl, id } = await written()
    const req = ctrl.get(id)!.requests[0]
    await ctrl.setTest(id, req.id, { ok: true, status: 200, ms: 1, json: RESPONSE })
    await ctrl.setTest(id, req.id, { ok: false, ms: 1, error: 'No answer within 20 seconds.' })
    expect(ctrl.get(id)!.requests[0].test).toMatchObject({ ok: false, error: 'No answer within 20 seconds.' })
    expect(ctrl.get(id)!.requests[0].test!.fields!.length).toBe(2)
  })

  it('setRecordsPath picks other records from the last response', async () => {
    const m = memory()
    const ctrl = new BoxController(m.io)
    const box = ctrl.add(null)
    const req = box.requests[0]
    await ctrl.setTest(box.id, req.id, { ok: true, ms: 1, json: { users: [{ n: 1 }, { n: 2 }], teams: [{ t: 'x' }] } })
    await ctrl.setRecordsPath(box.id, req.id, ['teams'])
    const r = ctrl.get(box.id)!.requests[0]
    expect(r.recordsPath).toEqual(['teams'])
    expect(r.test!.fields!.map((f) => f.name)).toEqual(['t'])
    expect(r.ticked).toEqual(['t'])
    expect(ctrl.recordChoices(box.id, req.id)).toEqual([{ path: ['users'], count: 2 }, { path: ['teams'], count: 1 }])
  })

  it('currentBlock: the code as it is in the file now (for the Overwrite diff)', async () => {
    const { m, ctrl, id } = await written()
    expect(await ctrl.currentBlock(id)).toBe(ctrl.preview(id))
    m.files.set('api/github.py', 'gone\n')
    expect(await ctrl.currentBlock(id)).toBeNull()
  })

  it('setTest keeps the status text', async () => {
    const { ctrl, id } = await written()
    const req = ctrl.get(id)!.requests[0]
    await ctrl.setTest(id, req.id, { ok: true, status: 200, statusText: 'OK', ms: 1, json: RESPONSE })
    expect(ctrl.get(id)!.requests[0].test!.statusText).toBe('OK')
  })

  it('load: boxes from boxes.json', () => {
    const { ctrl } = { ctrl: new BoxController(memory().io) }
    ctrl.load({ version: 1, boxes: [{ type: 'api', id: 'gh-1', name: 'GitHub', requests: [] }] })
    expect(ctrl.boxes.map((b) => b.id)).toEqual(['gh-1'])
    expect(ctrl.selected).toBeNull()
  })
})
