/**
 * Runs the Pyright language server and passes messages between it and the
 * window. The main process only handles the process and the message framing;
 * the actual protocol logic lives in the renderer (src/renderer/lsp/).
 */
import { fork, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { encodeMessage, MessageReader } from './jsonrpc'
import { pythonCandidates } from './python'

/**
 * The interpreter Pyright should use to find installed packages: the
 * configured one, else a project virtualenv, else undefined (Pyright then
 * uses python from PATH itself).
 */
export async function resolvePythonForAnalysis(root: string, configured?: string): Promise<string | undefined> {
  if (configured) return configured
  for (const candidate of pythonCandidates(root, process.platform)) {
    if (!/[\\/]/.test(candidate)) break // reached bare commands like "python": let Pyright decide
    try {
      await access(candidate)
      return candidate
    } catch {
      // not there, try the next
    }
  }
  return undefined
}

export class LanguageServer {
  private proc: ChildProcess | null = null
  private generation = 0

  /** (Re)start Pyright. Messages from it are sent to `sender` as 'lsp:message'. */
  start(sender: WebContents): number {
    this.stop()
    const gen = ++this.generation
    const script = require.resolve('pyright/langserver.index.js')
    // fork() runs the script with Electron's own Node, so nothing extra is needed.
    const proc = fork(script, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [] })
    const reader = new MessageReader((message) => {
      if (gen === this.generation && !sender.isDestroyed()) sender.send('lsp:message', message)
    })
    proc.stdout?.on('data', (chunk: Buffer) => reader.feed(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (process.env['IDEFORFUN_LSP_LOG']) process.stderr.write(chunk)
    })
    proc.on('exit', (code) => {
      if (gen !== this.generation) return
      this.proc = null
      if (!sender.isDestroyed()) sender.send('lsp:exit', code)
    })
    this.proc = proc
    return gen
  }

  send(message: unknown): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(encodeMessage(message))
  }

  stop(): void {
    this.generation++
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null) p.kill()
  }
}
