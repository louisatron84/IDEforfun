import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageReader } from './jsonrpc'

describe('encodeMessage', () => {
  it('adds a Content-Length header counting bytes, not characters', () => {
    const buf = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { s: 'é' } })
    const text = buf.toString('utf8')
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { s: 'é' } })
    expect(text).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    expect(Buffer.byteLength(body)).toBe(body.length + 1) // é is 2 bytes
  })
})

describe('MessageReader', () => {
  const frame = (o: unknown) => encodeMessage(o)

  it('reads one message', () => {
    const got: unknown[] = []
    const r = new MessageReader((m) => got.push(m))
    r.feed(frame({ id: 1, result: 'ok' }))
    expect(got).toEqual([{ id: 1, result: 'ok' }])
  })

  it('reads several messages from one chunk', () => {
    const got: unknown[] = []
    const r = new MessageReader((m) => got.push(m))
    r.feed(Buffer.concat([frame({ a: 1 }), frame({ b: 2 }), frame({ c: 3 })]))
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('reassembles a message split at any byte, including inside a multi-byte character', () => {
    const whole = frame({ text: 'naïve café ☕' })
    for (let cut = 1; cut < whole.length; cut++) {
      const got: unknown[] = []
      const r = new MessageReader((m) => got.push(m))
      r.feed(whole.subarray(0, cut))
      r.feed(whole.subarray(cut))
      expect(got).toEqual([{ text: 'naïve café ☕' }])
    }
  })

  it('ignores extra headers like Content-Type', () => {
    const body = JSON.stringify({ ok: true })
    const got: unknown[] = []
    const r = new MessageReader((m) => got.push(m))
    r.feed(Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`))
    expect(got).toEqual([{ ok: true }])
  })
})
