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
  if (!/^https?:$/.test(new URL(built.url).protocol)) return fail('Only http:// and https:// addresses can be called.')

  const max = opts.maxBytes ?? MAX_RESPONSE_BYTES
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await (opts.fetchImpl ?? fetch)(built.url, { method: built.method, headers: built.headers, body: built.body, signal: abort.signal, redirect: 'follow' })
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
