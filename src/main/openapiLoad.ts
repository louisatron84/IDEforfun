/**
 * Loads an OpenAPI description for "Add API from OpenAPI": from an http(s)
 * address or a file, as JSON or YAML. Nothing secret is sent with the request.
 */
import { readFile, stat } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

export const MAX_SPEC_BYTES = 10 * 1024 * 1024

export interface LoadedSpec {
  doc?: unknown
  /** Where it came from (resolves relative server addresses). */
  from: string
  error?: string
}

/** JSON, else YAML. */
export function parseSpecText(text: string): unknown {
  const t = text.replace(/^﻿/, '')
  try {
    return JSON.parse(t)
  } catch {
    return parseYaml(t, { maxAliasCount: 1000 })
  }
}

export async function loadSpec(source: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<LoadedSpec> {
  const from = source.trim()
  if (!from) return { from, error: 'Give the address or file of an OpenAPI description.' }
  let text: string
  if (/^https?:\/\//i.test(from)) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 20_000)
    try {
      const res = await (opts.fetchImpl ?? fetch)(from, { signal: abort.signal, headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } })
      if (!res.ok) return { from, error: `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.` }
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > MAX_SPEC_BYTES) return { from, error: 'That description is too large (over 10 MB).' }
      text = await res.text()
    } catch (err) {
      return { from, error: abort.signal.aborted ? 'The server took too long to answer.' : `Couldn't fetch it: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      clearTimeout(timer)
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from) && !/^[a-z]:[\\/]/i.test(from)) {
    return { from, error: 'Only http(s) addresses and files can be loaded.' }
  } else {
    try {
      if ((await stat(from)).size > MAX_SPEC_BYTES) return { from, error: 'That file is too large (over 10 MB).' }
      text = await readFile(from, 'utf8')
    } catch (err) {
      return { from, error: `Couldn't read the file: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (text.length > MAX_SPEC_BYTES) return { from, error: 'That description is too large (over 10 MB).' }
  try {
    return { from, doc: parseSpecText(text) }
  } catch (err) {
    return { from, error: `It isn't valid JSON or YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` }
  }
}
