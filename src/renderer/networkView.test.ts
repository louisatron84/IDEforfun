import { describe, expect, it } from 'vitest'
import { msText, prettyBody, statusText } from './networkView'
import type { NetRecord } from '../shared/network'

const rec = (over: Partial<NetRecord>): NetRecord => ({
  id: 1, kind: 'http', lib: 'requests', method: 'GET', url: 'https://a.com/', host: 'a.com', status: 200, error: null,
  start: 0, ms: 10, func: null, reqHeaders: [], respHeaders: [], reqBody: null, respBody: null, size: null, ...over
})

describe('Network panel text', () => {
  it('status: the code, the error name, or still going', () => {
    expect(statusText(rec({ status: 404 }))).toBe('404')
    expect(statusText(rec({ status: null, error: 'ConnectionRefusedError: [WinError 10061] refused' }))).toBe('ConnectionRefusedError')
    expect(statusText(rec({ status: null, ms: null }))).toBe('…')
    expect(statusText(rec({ kind: 'socket', status: null }))).toBe('connected')
  })
  it('times in ms, then seconds', () => {
    expect(msText(null)).toBe('')
    expect(msText(12.4)).toBe('12 ms')
    expect(msText(1534)).toBe('1.5 s')
    expect(msText(23000)).toBe('23 s')
  })
  it('JSON bodies are indented, others left alone (including cut-off JSON)', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyBody('{"a":1, "b"')).toBe('{"a":1, "b"')
    expect(prettyBody('name=ann')).toBe('name=ann')
  })
})
