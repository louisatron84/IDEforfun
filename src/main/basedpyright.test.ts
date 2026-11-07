/**
 * The bundled language server (basedpyright) starts from the path Forge uses,
 * and answers semantic-token requests (what each name is) for a Python file.
 */
import { describe, expect, it } from 'vitest'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeMessage, MessageReader } from './jsonrpc'
import { SERVERS } from './languageServer'
import { pathToUri } from '../shared/uri'
import { decodeSemanticTokens } from '../renderer/editor/semantic'

describe('basedpyright', () => {
  it('answers semantic tokens', async () => {
    const launch = SERVERS.pyright
    if (launch.kind !== 'node') throw new Error('expected a node server')
    const dir = mkdtempSync(join(tmpdir(), 'forge-bpr-'))
    const proc = fork(require.resolve(launch.module), [...launch.args], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [] })
    const waiting = new Map<number, (r: unknown) => void>()
    const reader = new MessageReader((m: any) => {
      if (m.id !== undefined && m.method === 'workspace/configuration') {
        proc.stdin!.write(encodeMessage({ jsonrpc: '2.0', id: m.id, result: m.params.items.map((i: { section?: string }) => (/analysis/.test(i.section ?? '') ? { typeCheckingMode: 'standard', diagnosticMode: 'openFilesOnly' } : {})) }))
      } else if (m.id !== undefined && m.method) {
        proc.stdin!.write(encodeMessage({ jsonrpc: '2.0', id: m.id, result: null }))
      } else if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)!(m.result)
        waiting.delete(m.id)
      }
    })
    proc.stdout!.on('data', (c: Buffer) => reader.feed(c))
    let next = 1
    const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      proc.stdin!.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
    })
    const notify = (method: string, params: unknown) => proc.stdin!.write(encodeMessage({ jsonrpc: '2.0', method, params }))
    try {
      const init = await request('initialize', {
        processId: null, rootUri: pathToUri(dir), workspaceFolders: [{ uri: pathToUri(dir), name: 'x' }],
        capabilities: { workspace: { configuration: true }, textDocument: { semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] } } }
      })
      const legend = init.capabilities.semanticTokensProvider?.legend
      expect(legend?.tokenTypes).toContain('parameter')
      notify('initialized', {})
      const uri = pathToUri(join(dir, 'a.py'))
      notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: 'import os\n\nclass Shop:\n    def total(self, price):\n        return price * 2\n' } })
      const res = await request('textDocument/semanticTokens/full', { textDocument: { uri } })
      const byLine = decodeSemanticTokens(res.data, legend)
      expect(byLine.get(0)).toEqual([{ start: 7, end: 9, type: 'sem-module' }])
      expect(byLine.get(4)?.map((t) => t.type)).toContain('sem-parameter')
      expect(byLine.get(2)?.map((t) => t.type)).toContain('sem-class')
    } finally {
      proc.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})
