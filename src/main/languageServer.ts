/**
 * Runs language servers and passes messages between them and the window.
 * The main process only handles the processes and the message framing; the
 * protocol logic lives in the renderer (src/renderer/lsp/). Several servers
 * can run side by side, one per id in SERVERS.
 */
import { fork, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { encodeMessage, MessageReader } from './jsonrpc'
import { pythonCandidates } from './python'

/** How to start a server: a Node script bundled with the app, or a command on PATH. */
export type ServerLaunch =
  | { kind: 'node'; module: string; args: readonly string[] }
  | { kind: 'command'; command: string; args: readonly string[] }

/** Every language server the IDE knows how to start (ids match `server` in src/shared/languages.ts). */
export const SERVERS: Readonly<Record<string, ServerLaunch>> = {
  pyright: { kind: 'node', module: 'pyright/langserver.index.js', args: ['--stdio'] }
}

/**
 * In the installed app, modules live in resources/app.asar, which a separate
 * Node process can't run from: they are unpacked next to it (see "asarUnpack"
 * in package.json), so point at that copy.
 */
export function unpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

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

/** One running server process. */
class ServerProcess {
  private proc: ChildProcess | null = null
  private generation = 0

  constructor(private readonly id: string, private readonly launch: ServerLaunch) {}

  /** (Re)start it. Its messages go to `sender` as 'lsp:message' (id, message). */
  start(sender: WebContents): void {
    this.stop()
    const gen = ++this.generation
    const id = this.id
    const stdio: ['pipe', 'pipe', 'pipe', 'ipc'] = ['pipe', 'pipe', 'pipe', 'ipc']
    const proc =
      this.launch.kind === 'node'
        ? // fork() runs the script with Electron's own Node, so nothing extra is needed.
          fork(unpackedPath(require.resolve(this.launch.module)), [...this.launch.args], { stdio, execArgv: [] })
        : spawn(this.launch.command, [...this.launch.args], { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    const reader = new MessageReader((message) => {
      if (gen === this.generation && !sender.isDestroyed()) sender.send('lsp:message', id, message)
    })
    proc.stdout?.on('data', (chunk: Buffer) => reader.feed(chunk))
    // Writing to a server that just exited fails with EPIPE: ignore it (the exit is handled below).
    proc.stdin?.on('error', () => {})
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (process.env['IDEFORFUN_LSP_LOG']) process.stderr.write(chunk)
    })
    const exited = (code: number | null) => {
      if (gen !== this.generation) return
      this.generation++
      this.proc = null
      if (!sender.isDestroyed()) sender.send('lsp:exit', id, code)
    }
    proc.on('exit', exited)
    // A command that isn't installed fails to spawn instead of exiting.
    proc.on('error', () => exited(null))
    this.proc = proc
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

export class LanguageServers {
  private readonly running = new Map<string, ServerProcess>()

  constructor(private readonly registry: Readonly<Record<string, ServerLaunch>> = SERVERS) {}

  /** (Re)start the server with this id. Unknown ids are refused (the window can't run arbitrary commands). */
  start(id: string, sender: WebContents): void {
    const launch = Object.hasOwn(this.registry, id) ? this.registry[id] : undefined
    if (!launch) throw new Error(`Unknown language server: ${id}`)
    let server = this.running.get(id)
    if (!server) this.running.set(id, (server = new ServerProcess(id, launch)))
    server.start(sender)
  }

  send(id: string, message: unknown): void {
    this.running.get(id)?.send(message)
  }

  /** Stop one server, or all of them. */
  stop(id?: string): void {
    if (id !== undefined) this.running.get(id)?.stop()
    else for (const s of this.running.values()) s.stop()
  }
}
