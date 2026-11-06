import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { newApiBox, type ApiBox } from '../shared/boxes'
import { testCall } from './apiCall'

let server: Server
let base = ''
let root = ''
let lastAuth: string | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'forge-apicall-'))
  writeFileSync(join(root, '.env'), 'FORGE_TEST_TOKEN=from-dotenv\n')
  server = createServer((req, res) => {
    lastAuth = req.headers.authorization
    if (req.url === '/users') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify([{ login: 'ann' }, { login: 'bo' }]))
    } else if (req.url === '/text') res.end('hello there')
    else if (req.url === '/big') res.end(JSON.stringify({ blob: 'x'.repeat(5000) }))
    else {
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'Not Found' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function box(url: string): ApiBox {
  const b = newApiBox([], 'Test')
  b.baseUrl = base
  b.auth = { kind: 'bearer', env: 'FORGE_TEST_TOKEN' }
  b.requests[0].url = url
  return b
}

describe('test call', () => {
  it('JSON, with the secret from the project .env', async () => {
    const b = box('/users')
    const r = await testCall(root, b, b.requests[0].id)
    expect(r).toMatchObject({ ok: true, status: 200, json: [{ login: 'ann' }, { login: 'bo' }] })
    expect(r.ms).toBeGreaterThanOrEqual(0)
    expect(lastAuth).toBe('Bearer from-dotenv')
  })

  it('an error status keeps the body', async () => {
    const b = box('/nope')
    expect(await testCall(root, b, b.requests[0].id)).toMatchObject({ ok: false, status: 404, json: { message: 'Not Found' } })
  })

  it('text that is not JSON', async () => {
    const b = box('/text')
    expect(await testCall(root, b, b.requests[0].id)).toMatchObject({ ok: true, text: 'hello there' })
  })

  it('too big', async () => {
    const b = box('/big')
    const r = await testCall(root, b, b.requests[0].id, { maxBytes: 1000 })
    expect(r).toMatchObject({ ok: false, tooBig: true })
    expect(r.json).toBeUndefined()
  })

  it('refuses other URL schemes and reports missing secrets, without sending', async () => {
    const b = box('file:///etc/passwd')
    b.baseUrl = ''
    expect((await testCall(root, b, b.requests[0].id)).error).toMatch(/http/)
    const c = box('/users')
    c.auth = { kind: 'bearer', env: 'FORGE_TEST_NOT_SET' }
    expect((await testCall(root, c, c.requests[0].id)).error).toBe('FORGE_TEST_NOT_SET is not set: add it to .env')
    expect((await testCall(root, c, 'nope')).error).toMatch(/request/)
  })
})
