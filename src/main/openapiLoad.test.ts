import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSpec, parseSpecText } from './openapiLoad'

describe('parseSpecText', () => {
  it('reads JSON and YAML', () => {
    expect(parseSpecText('{"openapi": "3.0.0"}')).toEqual({ openapi: '3.0.0' })
    expect(parseSpecText('openapi: 3.0.0\ninfo:\n  title: X\n')).toEqual({ openapi: '3.0.0', info: { title: 'X' } })
    expect(parseSpecText('﻿{"a": 1}')).toEqual({ a: 1 })
  })
})

describe('loadSpec', () => {
  it('reads a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-spec-'))
    try {
      const file = join(dir, 'api.yaml')
      writeFileSync(file, 'swagger: "2.0"\ninfo: {title: Shop}\n')
      expect(await loadSpec(file)).toEqual({ from: file, doc: { swagger: '2.0', info: { title: 'Shop' } } })
      expect((await loadSpec(join(dir, 'missing.json'))).error).toMatch(/Couldn't read/)
      writeFileSync(file, 'a: [unclosed\n')
      expect((await loadSpec(file)).error).toMatch(/isn't valid JSON or YAML/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fetches an address, and reports server errors', async () => {
    const ok = (async () => new Response('{"openapi":"3.1.0"}', { status: 200 })) as unknown as typeof fetch
    expect(await loadSpec('https://x.test/openapi.json', { fetchImpl: ok })).toEqual({ from: 'https://x.test/openapi.json', doc: { openapi: '3.1.0' } })
    const missing = (async () => new Response('no', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch
    expect((await loadSpec('https://x.test/o.json', { fetchImpl: missing })).error).toBe('The server answered 404 Not Found.')
  })

  it('refuses other kinds of address, and nothing at all', async () => {
    expect((await loadSpec('ftp://x/y')).error).toMatch(/Only http/)
    expect((await loadSpec('  ')).error).toMatch(/Give the address/)
  })
})
