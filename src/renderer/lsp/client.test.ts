import { describe, expect, it } from 'vitest'
import { LspClient } from './client'

function setup() {
  const sent: any[] = []
  const client = new LspClient((m) => sent.push(m))
  return { client, sent }
}

describe('LspClient', () => {
  it('sends requests with increasing ids and resolves them with the matching response', async () => {
    const { client, sent } = setup()
    const a = client.request('a', { x: 1 })
    const b = client.request('b', {})
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'b', params: {} }
    ])
    client.handleMessage({ jsonrpc: '2.0', id: 2, result: 'B' })
    client.handleMessage({ jsonrpc: '2.0', id: 1, result: 'A' })
    expect(await a).toBe('A')
    expect(await b).toBe('B')
  })

  it('rejects requests that come back with an error', async () => {
    const { client } = setup()
    const p = client.request('x', {})
    client.handleMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } })
    await expect(p).rejects.toThrow('nope')
  })

  it('sends notifications without an id', () => {
    const { client, sent } = setup()
    client.notify('initialized', {})
    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'initialized', params: {} }])
  })

  it('delivers server notifications to listeners', () => {
    const { client } = setup()
    const got: unknown[] = []
    client.onNotification('textDocument/publishDiagnostics', (p) => got.push(p))
    client.handleMessage({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'u' } })
    client.handleMessage({ jsonrpc: '2.0', method: 'other', params: {} })
    expect(got).toEqual([{ uri: 'u' }])
  })

  it('answers requests from the server using a handler, or null if there is none', async () => {
    const { client, sent } = setup()
    client.onRequest('workspace/configuration', (params: any) => params.items.map(() => ({ ok: true })))
    client.handleMessage({ jsonrpc: '2.0', id: 'srv-1', method: 'workspace/configuration', params: { items: [{}, {}] } })
    client.handleMessage({ jsonrpc: '2.0', id: 'srv-2', method: 'client/registerCapability', params: {} })
    await Promise.resolve()
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', result: [{ ok: true }, { ok: true }] },
      { jsonrpc: '2.0', id: 'srv-2', result: null }
    ])
  })

  it('fails all pending requests when the server goes away', async () => {
    const { client } = setup()
    const p = client.request('slow', {})
    client.dispose('server exited')
    await expect(p).rejects.toThrow('server exited')
  })
})
