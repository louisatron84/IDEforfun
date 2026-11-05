import { describe, expect, it } from 'vitest'
import { DapClient } from './dapClient'

function setup() {
  const sent: any[] = []
  const client = new DapClient((m) => sent.push(m))
  return { client, sent }
}

describe('DapClient', () => {
  it('numbers requests and resolves them with the response body', async () => {
    const { client, sent } = setup()
    const p = client.request('threads')
    const q = client.request('scopes', { frameId: 3 })
    expect(sent).toEqual([
      { seq: 1, type: 'request', command: 'threads' },
      { seq: 2, type: 'request', command: 'scopes', arguments: { frameId: 3 } }
    ])
    client.handleMessage({ type: 'response', request_seq: 2, success: true, command: 'scopes', body: { scopes: [] } })
    client.handleMessage({ type: 'response', request_seq: 1, success: true, command: 'threads', body: { threads: [{ id: 1 }] } })
    expect(await p).toEqual({ threads: [{ id: 1 }] })
    expect(await q).toEqual({ scopes: [] })
  })
  it('rejects failed requests with the adapter message', async () => {
    const { client } = setup()
    const p = client.request('evaluate', { expression: 'nope' })
    client.handleMessage({ type: 'response', request_seq: 1, success: false, command: 'evaluate', message: "name 'nope' is not defined" })
    await expect(p).rejects.toThrow("name 'nope' is not defined")
  })
  it('passes events to listeners', () => {
    const { client } = setup()
    const got: string[] = []
    client.onEvent((e) => got.push(e.event))
    client.handleMessage({ type: 'event', event: 'stopped', body: { threadId: 1 } })
    expect(got).toEqual(['stopped'])
  })
  it('declines reverse requests', () => {
    const { client, sent } = setup()
    client.handleMessage({ type: 'request', seq: 7, command: 'runInTerminal', arguments: {} })
    expect(sent[0]).toMatchObject({ type: 'response', request_seq: 7, success: false, command: 'runInTerminal' })
  })
  it('fails pending requests when disposed', async () => {
    const { client } = setup()
    const p = client.request('continue')
    client.dispose('gone')
    await expect(p).rejects.toThrow('gone')
  })
})
