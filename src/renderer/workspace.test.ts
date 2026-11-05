import { describe, expect, it } from 'vitest'
import { Workspace, isInside, samePath } from './workspace'
import type { Doc } from './editor/document'

function setup(files: Record<string, string>, allowDiscard = true) {
  const written: Record<string, string> = {}
  const asked: string[] = []
  const ws = new Workspace(
    {
      readTextFile: async (p) => {
        if (!(p in files)) throw new Error('ENOENT ' + p)
        return { kind: 'text', text: files[p], encoding: 'utf8', size: files[p].length }
      },
      writeTextFile: async (p, t) => { written[p] = t }
    },
    (doc: Doc) => { asked.push(doc.name); return allowDiscard }
  )
  return { ws, written, asked }
}

describe('Workspace (tabs)', () => {
  it('opens files as tabs and re-uses an already open tab', async () => {
    const { ws } = setup({ 'C:\\p\\a.py': 'a', 'C:\\p\\b.py': 'b' })
    const a = await ws.open('C:\\p\\a.py')
    await ws.open('C:\\p\\b.py')
    expect(ws.docs.map((d) => d.name)).toEqual(['a.py', 'b.py'])
    expect(ws.active?.name).toBe('b.py')

    const again = await ws.open('c:/p/A.py') // different slashes/case on Windows
    expect(again).toBe(a)
    expect(ws.docs).toHaveLength(2)
    expect(ws.active).toBe(a)
  })

  it('opens a new tab right after the active one', async () => {
    const { ws } = setup({ '/a': '', '/b': '', '/c': '' })
    const a = await ws.open('/a')
    await ws.open('/b')
    ws.activate(a)
    await ws.open('/c')
    expect(ws.docs.map((d) => d.path)).toEqual(['/a', '/c', '/b'])
  })

  it('closing the active tab activates its neighbour', async () => {
    const { ws } = setup({ '/a': '', '/b': '', '/c': '' })
    await ws.open('/a')
    const b = await ws.open('/b')
    await ws.open('/c')
    ws.activate(b)
    ws.close(b)
    expect(ws.active?.path).toBe('/c')
    ws.close(ws.active!)
    expect(ws.active?.path).toBe('/a')
    ws.close(ws.active!)
    expect(ws.active).toBeNull()
  })

  it('asks before closing a tab with unsaved changes', async () => {
    const { ws, asked } = setup({ '/a': 'x' }, false)
    const a = await ws.open('/a')
    a.history.transact('typing', { line: 0, col: 1 }, () => a.buffer.insert({ line: 0, col: 1 }, 'y'))
    expect(ws.close(a)).toBe(false)
    expect(asked).toEqual(['a'])
    expect(ws.docs).toHaveLength(1)
  })

  it('saves the active doc and clears its dirty state', async () => {
    const { ws, written } = setup({ '/a': 'x' })
    const a = await ws.open('/a')
    a.history.transact('typing', { line: 0, col: 1 }, () => a.buffer.insert({ line: 0, col: 1 }, 'y'))
    expect(ws.anyDirty).toBe(true)
    await ws.save()
    expect(written['/a']).toBe('xy')
    expect(a.dirty).toBe(false)
  })

  it('cycles through tabs with next(+1/-1), wrapping around', async () => {
    const { ws } = setup({ '/a': '', '/b': '', '/c': '' })
    await ws.open('/a'); await ws.open('/b'); await ws.open('/c')
    ws.next(1)
    expect(ws.active?.path).toBe('/a')
    ws.next(-1)
    expect(ws.active?.path).toBe('/c')
  })

  it('notifies listeners on changes', async () => {
    const { ws } = setup({ '/a': '' })
    let calls = 0
    ws.subscribe(() => calls++)
    await ws.open('/a')
    ws.notifyChanged()
    expect(calls).toBe(2)
  })
})

describe('samePath', () => {
  it('ignores slash direction and case for Windows paths only', () => {
    expect(samePath('C:\\X\\a.py', 'c:/x/A.py')).toBe(true)
    expect(samePath('/home/a.py', '/home/A.py')).toBe(false)
  })
})

describe('isInside', () => {
  it('matches the path itself and anything below it', () => {
    expect(isInside('C:\\p\\pkg', 'C:\\p\\pkg')).toBe(true)
    expect(isInside('C:\\p\\pkg\\a.py', 'c:/p/PKG')).toBe(true)
    expect(isInside('C:\\p\\pkg2\\a.py', 'C:\\p\\pkg')).toBe(false)
    expect(isInside('/home/u/pkg/a.py', '/home/u/pkg')).toBe(true)
    expect(isInside('/home/u/pkg2', '/home/u/pkg')).toBe(false)
  })
})

describe('Workspace: files renamed or deleted on disk', () => {
  const files = { 'C:\\p\\pkg\\a.py': 'a', 'C:\\p\\pkg\\b.py': 'b', 'C:\\p\\main.py': 'm' }

  it('renaming a folder moves its open tabs to the new paths', async () => {
    const { ws } = setup(files)
    const a = await ws.open('C:\\p\\pkg\\a.py')
    const m = await ws.open('C:\\p\\main.py')
    const moved = ws.pathRenamed('C:\\p\\pkg', 'C:\\p\\lib')
    expect(moved).toEqual([a])
    expect(a.path).toBe('C:\\p\\lib\\a.py')
    expect(m.path).toBe('C:\\p\\main.py')
  })
  it('renaming a file renames its tab', async () => {
    const { ws } = setup(files)
    const m = await ws.open('C:\\p\\main.py')
    ws.pathRenamed('C:\\p\\main.py', 'C:\\p\\app.py')
    expect(m.name).toBe('app.py')
  })
  it('deleting closes the affected tabs without asking, even unsaved ones', async () => {
    const { ws, asked } = setup(files, false)
    await ws.open('C:\\p\\pkg\\a.py')
    const b = await ws.open('C:\\p\\pkg\\b.py')
    const m = await ws.open('C:\\p\\main.py')
    b.buffer.insert({ line: 0, col: 0 }, 'x')
    ws.activate(b)
    ws.discard(ws.docsUnder('C:\\p\\pkg'))
    expect(ws.docs).toEqual([m])
    expect(ws.active).toBe(m)
    expect(asked).toEqual([])
  })
})

describe('Workspace: split into two groups', () => {
  const files = { '/p/a.py': 'a', '/p/b.py': 'b', '/p/c.py': 'c' }

  it('split shows the active file in a second group that gets focus', async () => {
    const { ws } = setup(files)
    const a = await ws.open('/p/a.py')
    ws.split()
    expect(ws.groups.length).toBe(2)
    expect(ws.activeGroup).toBe(1)
    expect(ws.groups[1].docs).toEqual([a])
    expect(ws.docs).toEqual([a]) // the same file once
  })
  it('opening goes into the focused group; the other group keeps its tabs', async () => {
    const { ws } = setup(files)
    const a = await ws.open('/p/a.py')
    ws.split()
    const b = await ws.open('/p/b.py')
    expect(ws.groups[0].docs).toEqual([a])
    expect(ws.groups[1].docs).toEqual([a, b])
    ws.focusGroup(0)
    expect(ws.active).toBe(a)
  })
  it('a file open in both groups only asks about unsaved changes when its last tab closes', async () => {
    const { ws, asked } = setup(files)
    const a = await ws.open('/p/a.py')
    await ws.open('/p/b.py')
    ws.split()
    ws.activate(a, 1)
    a.history.transact('typing', { line: 0, col: 0 }, () => a.buffer.insert({ line: 0, col: 0 }, 'x'))
    expect(ws.groups[1].docs).toContain(a)
    ws.close(a, 0)
    expect(asked).toEqual([])
    ws.close(a, 1)
    expect(asked).toEqual(['a.py'])
  })
  it('closing the last tab of the second group removes the split', async () => {
    const { ws } = setup(files)
    const a = await ws.open('/p/a.py')
    ws.split()
    ws.close(a, 1)
    expect(ws.groups.length).toBe(1)
    expect(ws.activeGroup).toBe(0)
    expect(ws.active).toBe(a)
  })
  it('move to the other group', async () => {
    const { ws } = setup(files)
    const a = await ws.open('/p/a.py')
    const b = await ws.open('/p/b.py')
    ws.moveToOtherGroup()
    expect(ws.groups[0].docs).toEqual([a])
    expect(ws.groups[1].docs).toEqual([b])
    expect(ws.active).toBe(b)
  })
  it('deleted files disappear from both groups', async () => {
    const { ws } = setup(files)
    const a = await ws.open('/p/a.py')
    ws.split()
    await ws.open('/p/c.py')
    ws.discard([a])
    expect(ws.groups.length).toBe(1)
    expect(ws.docs.map((d) => d.name)).toEqual(['c.py'])
  })
})

describe('Workspace: opening several files quickly', () => {
  it('keeps the tabs in the order they were opened, however long each read takes', async () => {
    const delays: Record<string, number> = { '/p/a.py': 30, '/p/b.py': 0, '/p/c.py': 10 }
    const ws = new Workspace({
      readTextFile: (p) => new Promise((resolve) => setTimeout(() => resolve({ kind: 'text', text: p, encoding: 'utf8', size: 1 }), delays[p])),
      writeTextFile: async () => {}
    }, () => true)
    await Promise.all(['/p/a.py', '/p/b.py', '/p/c.py'].map((p) => ws.open(p)))
    expect(ws.docs.map((d) => d.name)).toEqual(['a.py', 'b.py', 'c.py'])
    expect(ws.active?.name).toBe('c.py')
  })
  it('a failed open does not block the next one', async () => {
    const { ws } = setup({ '/p/a.py': 'a' })
    await expect(ws.open('/p/missing.py')).rejects.toThrow()
    expect((await ws.open('/p/a.py')).name).toBe('a.py')
  })
})
