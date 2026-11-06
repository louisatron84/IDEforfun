/**
 * Runs the debugpy debug adapter (`python -m debugpy.adapter`) and passes
 * Debug Adapter Protocol messages between it and the window. Like the
 * language server, the main process only handles the process and the
 * Content-Length framing; the protocol logic lives in src/renderer/debug/.
 *
 * Connection 0 is the adapter's stdin/stdout (the program being debugged).
 * When that program starts child processes (multiprocessing, subprocess),
 * debugpy asks the IDE to attach to each one through a local port of the same
 * adapter: connect() opens those, numbered 1, 2, ...
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
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

/** Only the adapter's own local port may be connected to (the window can't open arbitrary sockets). */
export function isLocalEndpoint(host: unknown, port: unknown): boolean {
  return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536
}

export class DebugAdapter {
  private proc: ChildProcess | null = null
  private generation = 0
  private sender: WebContents | null = null
  private readonly sockets = new Map<number, Socket>()
  private nextConnection = 1

  /** Start the adapter for a new debug session (ending any previous one). */
  start(sender: WebContents, python: string, cwd: string): void {
    this.stop()
    const gen = ++this.generation
    this.sender = sender
    const proc = spawn(python, ['-m', 'debugpy.adapter'], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    })
    const reader = new MessageReader((message) => {
      if (gen === this.generation && !sender.isDestroyed()) sender.send('debug:message', 0, message)
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
      this.closeSockets()
      if (!sender.isDestroyed()) sender.send('debug:exit', 0, { code, error: error ?? (code ? stderr.trim() : undefined) })
    }
    proc.on('error', (err) => exited(null, err.message))
    proc.on('exit', (code) => exited(code))
    this.proc = proc
  }

  /**
   * Open another connection to the running adapter (to attach to a child
   * process). Resolves with its number once connected.
   */
  connect(host: string, port: number): Promise<number> {
    const sender = this.sender
    if (!this.proc || !sender) return Promise.reject(new Error('The debugger is not running'))
    if (!isLocalEndpoint(host, port)) return Promise.reject(new Error(`Not a local debugger address: ${host}:${port}`))
    const gen = this.generation
    const id = this.nextConnection++
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port })
      const reader = new MessageReader((message) => {
        if (gen === this.generation && !sender.isDestroyed()) sender.send('debug:message', id, message)
      })
      let connected = false
      socket.on('connect', () => {
        connected = true
        this.sockets.set(id, socket)
        resolve(id)
      })
      socket.on('data', (chunk: Buffer) => reader.feed(chunk))
      socket.on('error', (err) => {
        if (!connected) reject(err)
      })
      socket.on('close', () => {
        if (this.sockets.get(id) !== socket) return
        this.sockets.delete(id)
        if (gen === this.generation && !sender.isDestroyed()) sender.send('debug:exit', id, { code: null })
      })
    })
  }

  /** Send to connection `id` (0: the adapter's stdin). */
  send(id: number, message: unknown): void {
    if (id === 0) {
      if (this.proc?.stdin?.writable) this.proc.stdin.write(encodeMessage(message))
      return
    }
    const socket = this.sockets.get(id)
    if (socket?.writable) socket.write(encodeMessage(message))
  }

  private closeSockets(): void {
    const all = [...this.sockets.values()]
    this.sockets.clear()
    for (const s of all) s.destroy()
  }

  /** Kill the adapter (the program being debugged and its children go with it). */
  stop(): void {
    this.closeSockets()
    this.generation++
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null) p.kill()
  }
}
