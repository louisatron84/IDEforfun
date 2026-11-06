import { describe, expect, it } from 'vitest'
import { LspClient } from './client'
import { LspServer } from './server'
import { pyright } from './pyright'
import { Doc } from '../editor/document'

/** A fake server: records what the client sends and answers `initialize`. */
function setup() {
  const sent: any[] = []
  let client!: LspClient
  client = new LspClient((m: any) => {
    sent.push(m)
    if (m.method === 'initialize') queueMicrotask(() => client.handleMessage({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } }))
  })
  const timers: (() => void)[] = []
  const lang = new LspServer(client, pyright, { schedule: (fn) => { timers.push(fn); return () => {} } })
  const runTimers = () => timers.splice(0).forEach((f) => f())
  const methods = () => sent.filter((m) => m.method).map((m) => m.method)
  return { client, lang, sent, runTimers, methods }
}

const edit = (doc: Doc, text: string) =>
  doc.history.transact('typing', { line: 0, col: 0 }, () => doc.buffer.insert(doc.buffer.clamp({ line: 99, col: 99 }), text))

describe('LspServer (with the Pyright config)', () => {
  it('initializes, then sends initialized and the configuration', async () => {
    const { lang, sent, methods } = setup()
    await lang.start('C:\\proj', { pythonPath: 'C:\\proj\\.venv\\Scripts\\python.exe' })
    expect(methods()).toEqual(['initialize', 'initialized', 'workspace/didChangeConfiguration'])
    expect(sent[0].params.rootUri).toBe('file:///c%3A/proj')
  })

  it('answers workspace/configuration with the python path and analysis settings', async () => {
    const { client, lang, sent } = setup()
    await lang.start('/proj', { pythonPath: '/proj/.venv/bin/python' })
    client.handleMessage({ jsonrpc: '2.0', id: 'c1', method: 'workspace/configuration', params: { items: [{ section: 'python' }, { section: 'python.analysis' }, { section: 'other' }] } })
    await new Promise((r) => setTimeout(r, 0))
    const reply = sent.find((m) => m.id === 'c1')
    expect(reply.result[0]).toEqual({ pythonPath: '/proj/.venv/bin/python' })
    expect(reply.result[1]).toMatchObject({ diagnosticMode: 'openFilesOnly', autoSearchPaths: true })
    expect(reply.result[2]).toEqual({})
  })

  it('opens Python docs only, and closes docs that are gone', async () => {
    const { lang, sent } = setup()
    await lang.start('/proj')
    const py = new Doc('/proj/a.py', 'x = 1')
    const txt = new Doc('/proj/notes.txt', 'hi')
    lang.syncDocs([py, txt])
    const opens = sent.filter((m) => m.method === 'textDocument/didOpen')
    expect(opens).toHaveLength(1)
    expect(opens[0].params.textDocument).toEqual({ uri: 'file:///proj/a.py', languageId: 'python', version: 1, text: 'x = 1' })
    lang.syncDocs([txt])
    expect(sent.at(-1)).toMatchObject({ method: 'textDocument/didClose', params: { textDocument: { uri: 'file:///proj/a.py' } } })
  })

  it('batches edits into one didChange with the full text and a new version', async () => {
    const { lang, sent, runTimers } = setup()
    await lang.start('/proj')
    const doc = new Doc('/proj/a.py', 'x = 1')
    lang.syncDocs([doc])
    edit(doc, '\ny = 2'); lang.docChanged(doc)
    edit(doc, '\nz = 3'); lang.docChanged(doc)
    expect(sent.filter((m) => m.method === 'textDocument/didChange')).toHaveLength(0) // not yet: debounced
    runTimers()
    const changes = sent.filter((m) => m.method === 'textDocument/didChange')
    expect(changes).toHaveLength(1)
    expect(changes[0].params).toEqual({ textDocument: { uri: 'file:///proj/a.py', version: 2 }, contentChanges: [{ text: 'x = 1\ny = 2\nz = 3' }] })
  })

  it('flush() sends pending changes immediately (before asking for completions)', async () => {
    const { lang, sent } = setup()
    await lang.start('/proj')
    const doc = new Doc('/proj/a.py', '')
    lang.syncDocs([doc])
    edit(doc, 'import os'); lang.docChanged(doc)
    lang.flush()
    expect(sent.at(-1).method).toBe('textDocument/didChange')
  })

  it('stores diagnostics per file and tells listeners', async () => {
    const { client, lang } = setup()
    await lang.start('C:\\proj')
    let calls = 0
    lang.onDiagnostics(() => calls++)
    client.handleMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///c%3A/proj/a.py', diagnostics: [
        { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, severity: 1, message: '"foo" is not defined', source: 'Pyright', code: 'reportUndefinedVariable' }
      ] }
    })
    expect(calls).toBe(1)
    expect(lang.diagnosticsFor('c:\\PROJ\\a.py')).toMatchObject([
      { start: { line: 0, col: 4 }, end: { line: 0, col: 7 }, severity: 1, message: '"foo" is not defined', source: 'Pyright', code: 'reportUndefinedVariable' }
    ])
    expect(lang.diagnosticsFor('c:\\proj\\a.py')[0].server).toBe('pyright')
    expect(lang.allDiagnostics().map(([path]) => path)).toEqual(['C:\\proj\\a.py'])
  })

  it('re-opens tracked docs after a restart', async () => {
    const { lang, sent } = setup()
    await lang.start('/proj')
    lang.syncDocs([new Doc('/proj/a.py', 'x')])
    sent.length = 0
    await lang.start('/proj')
    expect(sent.filter((m) => m.method === 'textDocument/didOpen')).toHaveLength(1)
  })
})
