import { describe, expect, it } from 'vitest'
import { LspClient } from './client'
import { LspServer, type ServerConfig } from './server'
import { LanguageServices } from './services'
import { pyright } from './pyright'
import { Doc } from '../editor/document'

/** A fake server that answers initialize, hover and workspace/symbol, and records what it gets. */
function fakeServer(config: ServerConfig) {
  const sent: any[] = []
  let client!: LspClient
  client = new LspClient((m: any) => {
    sent.push(m)
    const reply = (result: unknown) => queueMicrotask(() => client.handleMessage({ jsonrpc: '2.0', id: m.id, result }))
    if (m.method === 'initialize') reply({ capabilities: {} })
    if (m.method === 'textDocument/hover') reply({ contents: `hover from ${config.id}` })
    if (m.method === 'workspace/symbol') reply([{ name: `${config.id}Symbol`, kind: 12, location: { uri: 'file:///proj/x', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }])
  })
  const server = new LspServer(client, config, { schedule: () => () => {} })
  const opened = () => sent.filter((m) => m.method === 'textDocument/didOpen').map((m) => m.params.textDocument.languageId + ' ' + m.params.textDocument.uri)
  return { client, server, sent, opened }
}

const jsonServer: ServerConfig = { id: 'jsonls', name: 'JSON server', languages: ['json'] }

async function setup() {
  const py = fakeServer(pyright)
  const json = fakeServer(jsonServer)
  const services = new LanguageServices([py.server, json.server])
  await py.server.start('/proj')
  await json.server.start('/proj')
  return { py, json, services }
}

const pyDiag = (line: number, col: number) => ({
  jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri: 'file:///c%3A/proj/a.py', diagnostics: [{ range: { start: { line, character: col }, end: { line, character: col + 3 } }, severity: 1, message: 'x', source: 'Pyright' }] }
})

describe('LanguageServices', () => {
  it('opens each document on the server for its language only', async () => {
    const { py, json, services } = await setup()
    services.syncDocs([new Doc('/proj/a.py', 'x'), new Doc('/proj/data.json', '{}'), new Doc('/proj/notes.txt', 'hi')])
    expect(py.opened()).toEqual(['python file:///proj/a.py'])
    expect(json.opened()).toEqual(['json file:///proj/data.json'])
  })

  it('sends questions to the server of the document', async () => {
    const { services } = await setup()
    const a = new Doc('/proj/a.py', 'x')
    const d = new Doc('/proj/data.json', '{}')
    const t = new Doc('/proj/notes.txt', 'hi')
    services.syncDocs([a, d, t])
    expect(await services.hover(a, { line: 0, col: 0 })).toBe('hover from pyright')
    expect(await services.hover(d, { line: 0, col: 0 })).toBe('hover from jsonls')
    expect(await services.hover(t, { line: 0, col: 0 })).toBeNull()
    expect(services.knows(a) && services.knows(d) && !services.knows(t)).toBe(true)
  })

  it('merges project symbols from every running server', async () => {
    const { services } = await setup()
    expect((await services.workspaceSymbols('x')).map((s) => s.name).sort()).toEqual(['jsonlsSymbol', 'pyrightSymbol'])
  })

  it("a stopped server is skipped (the other keeps working)", async () => {
    const { py, services } = await setup()
    const a = new Doc('/proj/a.py', 'x')
    const d = new Doc('/proj/data.json', '{}')
    services.syncDocs([a, d])
    py.server.stopped()
    expect(services.knows(a)).toBe(false)
    expect(await services.hover(d, { line: 0, col: 0 })).toBe('hover from jsonls')
    expect(services.isStarted).toBe(true)
  })

  it("shows other tools' diagnostics (Ruff) with the servers', minus duplicates", async () => {
    const { py, services } = await setup()
    let calls = 0
    services.onDiagnostics(() => calls++)
    py.client.handleMessage(pyDiag(0, 4))
    expect(calls).toBe(1)
    services.setExternalDiagnostics('ruff', 'C:\\proj\\a.py', [{ start: { line: 1, col: 0 }, end: { line: 1, col: 2 }, severity: 2, message: 'F401', source: 'Ruff' }])
    expect(services.diagnosticsFor('c:\\proj\\A.py').map((d) => d.source)).toEqual(['Pyright', 'Ruff'])
    expect(services.allDiagnostics()).toHaveLength(1)
    expect(services.allDiagnostics()[0][1]).toHaveLength(2)
    expect(calls).toBe(2)
    // ...except where a server already reports something at the same place.
    services.setExternalDiagnostics('ruff', 'C:\\proj\\a.py', [{ start: { line: 0, col: 4 }, end: { line: 0, col: 7 }, severity: 2, message: 'F821', source: 'Ruff' }])
    expect(services.diagnosticsFor('C:\\proj\\a.py').map((d) => d.source)).toEqual(['Pyright'])
    expect(services.allDiagnostics()[0][1]).toHaveLength(1)
    services.clearExternalDiagnostics('ruff')
    expect(services.diagnosticsFor('C:\\proj\\a.py')).toHaveLength(1)
    // A file only another tool reports on is listed too.
    services.setExternalDiagnostics('ruff', 'C:\\proj\\b.py', [{ start: { line: 0, col: 0 }, end: { line: 0, col: 1 }, severity: 2, message: 'E', source: 'Ruff' }])
    expect(services.allDiagnostics().map(([p]) => p).sort()).toEqual(['C:\\proj\\a.py', 'C:\\proj\\b.py'])
  })

  it('only passes a server its own diagnostics when asking for code actions', async () => {
    const { py, services } = await setup()
    const a = new Doc('/proj/a.py', 'x')
    services.syncDocs([a])
    const own = { start: { line: 0, col: 0 }, end: { line: 0, col: 1 }, severity: 1 as const, message: 'p', server: 'pyright', raw: { message: 'p' } }
    const ruff = { start: { line: 0, col: 0 }, end: { line: 0, col: 1 }, severity: 2 as const, message: 'r', source: 'Ruff', raw: { message: 'r' } }
    void services.codeActions(a, { line: 0, col: 0 }, { line: 0, col: 1 }, [own, ruff])
    const req = py.sent.find((m) => m.method === 'textDocument/codeAction')
    expect(req.params.context.diagnostics).toEqual([{ message: 'p' }])
  })
})
