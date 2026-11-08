/**
 * The Event-flow view's analysis with a real Python (skipped if there is
 * none): handlers registered by decorators and calls, events emitted, and
 * work started on tasks and threads.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScan } from './projectScan'
import { buildGraph, type ProjectGraph } from '../shared/projectGraph'
import { buildView } from '../renderer/graph/viewModel'

function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'import ast'], { stdio: 'ignore', timeout: 20000 })
      return cmd
    } catch {
      // try the next
    }
  }
  return null
}
const python = findPython()

const FILES: Record<string, string> = {
  'chat/__init__.py': '',
  'chat/server.py': [
    'import asyncio',
    'import threading',
    'import socketio',
    'from django.dispatch import receiver',
    'from django.db.models.signals import post_save',
    'from chat.store import save_message',
    '',
    'sio = socketio.AsyncServer()',
    '',
    "@sio.on('message')",
    'async def on_message(sid, data):',
    '    save_message(data)',
    "    await sio.emit('reply', data)",
    '',
    "@sio.on('reply')",
    'async def on_reply(sid, data):',
    '    print(data)',
    '',
    '@receiver(post_save)',
    'def audit(sender, **kw):',
    '    pass',
    '',
    'async def heartbeat():',
    '    while True:',
    '        await asyncio.sleep(1)',
    '',
    'def worker():',
    '    pass',
    '',
    'async def main():',
    '    asyncio.create_task(heartbeat())',
    '    threading.Thread(target=worker).start()'
  ].join('\n'),
  'chat/store.py': [
    'def save_message(data):',
    '    return data'
  ].join('\n'),
  'gui.py': [
    'import tkinter as tk',
    '',
    'def clicked():',
    "    print('hi')",
    '',
    'def on_key(event):',
    '    pass',
    '',
    'root = tk.Tk()',
    "button = tk.Button(root, text='Go', command=clicked)",
    "root.bind('<Key>', on_key)",
    "root.event_generate('<Key>')"
  ].join('\n'),
  'plain.py': 'def add(a, b):\n    return a + b\n'
}

describe.skipIf(!python)('event flow analysis (real Python)', () => {
  let dir: string
  let graph: ProjectGraph
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forge-events-'))
    for (const [rel, text] of Object.entries(FILES)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    const res = await runScan(python!, dir)
    expect(res.error).toBeUndefined()
    graph = buildGraph(res.scan!)
  }, 60000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const uses = (kind: string) => graph.events.filter((e) => e.kind === kind).map((e) => `${e.event ?? ''} ${e.func}${e.target ? ` → ${e.target}` : ''}`).sort()

  it('handlers: decorators, signal receivers, Tk command= and bind()', () => {
    expect(uses('handles')).toEqual([
      '<Key> gui:on_key',
      'Button command gui:clicked',
      'message chat.server:on_message',
      'post_save chat.server:audit',
      'reply chat.server:on_reply'
    ])
  })

  it('events emitted, from a function or from top-level code', () => {
    expect(uses('emits')).toEqual(['<Key> module:gui', 'reply chat.server:on_message'])
  })

  it('work started on tasks and threads', () => {
    expect(uses('spawns')).toEqual([' chat.server:main → chat.server:heartbeat', ' chat.server:main → chat.server:worker'])
  })

  it('the Events view: emitter → event → handler, what handlers call, and what is started', () => {
    const v = buildView(graph, { mode: 'events', focus: null, showExternal: false, showTests: false, showHosts: false, query: '' })
    const edges = v.edges.map((e) => `${e.from} ${e.kind} ${e.to}`)
    expect(edges).toContain('chat.server:on_message emits event:reply')
    expect(edges).toContain('event:reply handles chat.server:on_reply')
    expect(edges).toContain('event:message handles chat.server:on_message')
    expect(edges).toContain('chat.server:on_message call chat.store:save_message')
    expect(edges).toContain('chat.server:main spawns chat.server:heartbeat')
    const message = v.nodes.find((n) => n.id === 'event:message')!
    expect(message).toMatchObject({ kind: 'event', label: 'message' })
    expect(message.detail).toBe('event · from outside the code · 1 handler')
    expect(v.nodes.some((n) => n.id === 'plain:add')).toBe(false)
  })
})
