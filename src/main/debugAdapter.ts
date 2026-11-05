/**
 * Runs the debugpy debug adapter (`python -m debugpy.adapter`) and passes
 * Debug Adapter Protocol messages between it and the window. Like the
 * language server, the main process only handles the process and the
 * Content-Length framing; the protocol logic lives in src/renderer/debug/.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { encodeMessage, MessageReader } from './jsonrpc'
import { pythonCandidates } from './python'

const isBareCommand = (p: string) => !/[\\/]/.test(p)

function run(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() || (err ? err.message : '') })
    })
  })
}

/**
 * The full path of the interpreter Run would use: configured, else a project
 * virtualenv, else python on PATH (asked for its real path). Null if none works.
 */
export async function resolvePython(root: string, configured?: string): Promise<string | null> {
  // An interpreter chosen in Settings is the only one tried (a wrong one is reported, not replaced).
  for (const candidate of configured ? [configured] : pythonCandidates(root, process.platform)) {
    if (!isBareCommand(candidate)) {
      try {
        await access(candidate)
        return candidate
      } catch {
        continue
      }
    }
    const r = await run(candidate, ['-c', 'import sys; print(sys.executable)'], 15000)
    const exe = r.output.split(/\r?\n/).pop()?.trim()
    if (r.ok && exe) return exe
  }
  return null
}

export async function hasDebugpy(python: string): Promise<boolean> {
  return (await run(python, ['-c', 'import debugpy'], 20000)).ok
}

/** `python -m pip install debugpy` (up to 5 minutes). */
export function installDebugpy(python: string): Promise<{ ok: boolean; output: string }> {
  return run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'debugpy'], 5 * 60 * 1000)
}

export class DebugAdapter {
  private proc: ChildProcess | null = null
  private generation = 0

  /** Start the adapter for a new debug session (ending any previous one). */
  start(sender: WebContents, python: string, cwd: string): void {
    this.stop()
    const gen = ++this.generation
    const proc = spawn(python, ['-m', 'debugpy.adapter'], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    })
    const reader = new MessageReader((message) => {
      if (gen === this.generation && !sender.isDestroyed()) sender.send('debug:message', message)
    })
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => reader.feed(chunk))
    proc.stdin.on('error', () => {}) // EPIPE after the adapter exits: handled by 'exit'
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    const exited = (code: number | null, error?: string) => {
      if (gen !== this.generation) return
      this.proc = null
      if (!sender.isDestroyed()) sender.send('debug:exit', { code, error: error ?? (code ? stderr.trim() : undefined) })
    }
    proc.on('error', (err) => exited(null, err.message))
    proc.on('exit', (code) => exited(code))
    this.proc = proc
  }

  send(message: unknown): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(encodeMessage(message))
  }

  /** Kill the adapter (the program being debugged goes with it). */
  stop(): void {
    this.generation++
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null) p.kill()
  }
}
