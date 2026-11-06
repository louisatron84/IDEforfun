import { describe, expect, it } from 'vitest'
import { DebugAdapter, isLocalEndpoint } from './debugAdapter'

describe('DebugAdapter child-process connections', () => {
  it('only allows the local machine and a real port number', () => {
    expect(isLocalEndpoint('127.0.0.1', 5678)).toBe(true)
    expect(isLocalEndpoint('localhost', 1)).toBe(true)
    expect(isLocalEndpoint('::1', 65535)).toBe(true)
    expect(isLocalEndpoint('10.0.0.5', 5678)).toBe(false)
    expect(isLocalEndpoint('example.com', 80)).toBe(false)
    expect(isLocalEndpoint('127.0.0.1', 0)).toBe(false)
    expect(isLocalEndpoint('127.0.0.1', 70000)).toBe(false)
    expect(isLocalEndpoint('127.0.0.1', 1.5)).toBe(false)
    expect(isLocalEndpoint('127.0.0.1', '5678')).toBe(false)
  })

  it('refuses to connect when no debug session is running', async () => {
    await expect(new DebugAdapter().connect('127.0.0.1', 5678)).rejects.toThrow(/not running/)
  })
})
