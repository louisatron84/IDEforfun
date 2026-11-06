/**
 * The API box's ⚡ Test call: one real request, sent only when the user
 * presses the button, only to the box's http(s) URL, with secrets from the
 * environment and the project's .env (which never go back to the window).
 */
import type { ApiBox } from '../shared/boxes'
import { buildRequest } from '../shared/boxCode'
import type { TestCallResult } from '../shared/api'
import { processEnv } from './dotenvFile'

export type { TestCallResult }

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 20_000

export async function testCall(
  root: string,
  box: ApiBox,
  requestId: string,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {}
): Promise<TestCallResult> {
  const started = Date.now()
  const fail = (error: string): TestCallResult => ({ ok: false, ms: Date.now() - started, error })
  const req = box?.requests?.find((r) => r.id === requestId)
  if (!req) return fail('That request is not in the box.')
  const built = buildRequest(box, req, await processEnv(root))
  if ('error' in built) return fail(built.error)
  let first: URL
  try {
    first = new URL(built.url)
  } catch {
    return fail(`That URL isn't valid: ${built.url}`)
  }
  if (!/^https?:$/.test(first.protocol)) return fail('Only http:// and https:// addresses can be called.')

  const max = opts.maxBytes ?? MAX_RESPONSE_BYTES
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? TIMEOUT_MS)
  try {
    // Redirects are followed by hand: the box's key is never sent to another site.
    let url = first
    let method = built.method
    let body = built.body
    let res = await (opts.fetchImpl ?? fetch)(url, { method, headers: built.headers, body, signal: abort.signal, redirect: 'manual' })
    for (let hops = 0; res.status >= 300 && res.status < 400 && res.headers.get('location'); hops++) {
      const next = new URL(res.headers.get('location')!, url)
      if (hops >= 5) return fail('Too many redirects.')
      if (next.origin !== first.origin && box.auth.kind !== 'none') {
        return { ok: false, status: res.status, statusText: res.statusText, ms: Date.now() - started, error: `The API redirected to ${next.host}, another site, so Forge didn't send your key there. If that's right, use ${next.origin} as the URL.` }
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      await res.body?.cancel().catch(() => {})
      url = next
      res = await (opts.fetchImpl ?? fetch)(url, { method, headers: built.headers, body, signal: abort.signal, redirect: 'manual' })
    }
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body?.getReader()
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        return { ok: false, status: res.status, statusText: res.statusText, ms: Date.now() - started, tooBig: true, error: `The response is over ${max >= 1024 * 1024 ? `${Math.round(max / 1024 / 1024)} MB` : `${max} bytes`}: too big for a test call.` }
      }
      chunks.push(value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const result: TestCallResult = { ok: res.ok, status: res.status, statusText: res.statusText, ms: Date.now() - started }
    try {
      result.json = JSON.parse(text)
    } catch {
      result.text = text.slice(0, 2000)
    }
    return result
  } catch (err) {
    return fail(abort.signal.aborted ? 'No answer within 20 seconds.' : err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err))
  } finally {
    clearTimeout(timer)
  }
}
