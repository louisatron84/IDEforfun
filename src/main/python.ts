/**
 * Running Python files for the "Run" command.
 *
 * Picks an interpreter (the project's virtualenv if it has one, otherwise
 * python on PATH), runs the file unbuffered so output appears live, and
 * streams stdout/stderr back to the window that asked.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { RunSpec } from '../shared/api'
import { access } from 'node:fs/promises'
import { win32, posix } from 'node:path'
import type { WebContents } from 'electron'
import type { RunEventBody } from '../shared/api'
import { OutputQueue, skippedNote } from '../shared/outputBuffer'

/** Output is sent to the window in batches this often... */
const BATCH_MS = 40
/** ...and at most this much is kept waiting (older output is skipped beyond that). */
const MAX_WAITING_CHARS = 1_000_000

/** Interpreters to try, best first. */
export function pythonCandidates(root: string, platform: NodeJS.Platform, configured?: string): string[] {
  const list: string[] = []
  if (configured) list.push(configured)
  if (platform === 'win32') {
    for (const dir of ['.venv', 'venv', 'env']) list.push(win32.join(root, dir, 'Scripts', 'python.exe'))
    list.push('python', 'py')
  } else {
    for (const dir of ['.venv', 'venv', 'env']) list.push(posix.join(root, dir, 'bin', 'python'))
    list.push('python3', 'python')
  }
  return list
}

const isBareCommand = (p: string) => !/[\\/]/.test(p)

export class PythonRunner {
  private child: ChildProcess | null = null
  private runId = 0

  /** Start a run; resolves with its id once it started (or failed to). */
  async run(sender: WebContents, spec: RunSpec): Promise<number> {
    const { root, python: configured } = spec
    this.stop()
    // Every event carries the run's id, so the window can ignore late events
    // from a previous run (e.g. its "exited" message after a restart).
    const runId = ++this.runId
    const send = (e: RunEventBody) => {
      if (!sender.isDestroyed()) sender.send('run:event', { ...e, runId })
    }

    // An interpreter chosen in Settings is used as-is: if it's wrong, say so rather
    // than quietly running some other Python.
    const candidates = configured ? [configured] : pythonCandidates(root, process.platform)
    for (const python of candidates) {
      // Paths (virtualenvs) must exist; bare commands are found on PATH by spawn.
      if (!isBareCommand(python)) {
        try {
          await access(python)
        } catch {
          continue
        }
      }
      const started = await this.trySpawn(python, spec, send)
      if (started) return runId
    }
    send({
      type: 'error',
      message: configured
        ? `The Python interpreter set in Settings wasn't found:\n  ${configured}\nFix it in Settings (Ctrl+,), or clear it to pick one automatically.`
        : 'Python was not found. Install it from python.org, or create a .venv in your project.'
    })
    send({ type: 'exit', code: null, ms: 0 })
    return runId
  }

  /** Resolves true once the process has started, false if this interpreter doesn't exist. */
  private trySpawn(python: string, spec: RunSpec, send: (e: RunEventBody) => void): Promise<boolean> {
    const file = spec.module ? `-m ${spec.module}` : spec.program ?? ''
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const target = spec.module ? ['-m', spec.module] : [spec.program ?? '']
      const child = spawn(python, ['-u', ...target, ...spec.args], {
        cwd: spec.cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...spec.env },
        windowsHide: true
      })
      let started = false
      child.once('spawn', () => {
        started = true
        this.child = child
        send({ type: 'start', python, file })
        resolve(true)
      })
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (!started) {
          resolve(false) // e.g. ENOENT: try the next interpreter
          return
        }
        send({ type: 'error', message: err.message })
      })
      child.stdin?.on('error', () => {}) // typing input after the program ended: nothing to do
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      // A program can print far faster than the window can draw: send output in
      // batches, and if it piles up, only the newest part (with a "skipped" note).
      const queue = new OutputQueue(MAX_WAITING_CHARS)
      let timer: NodeJS.Timeout | null = null
      const flush = () => {
        timer = null
        const { pieces, dropped } = queue.take()
        if (dropped) send({ type: 'output', stream: 'stderr', text: skippedNote(dropped) })
        for (const p of pieces) send({ type: 'output', stream: p.stream, text: p.text })
      }
      const collect = (stream: 'stdout' | 'stderr') => (text: string) => {
        queue.push(stream, text)
        timer ??= setTimeout(flush, BATCH_MS)
      }
      child.stdout?.on('data', collect('stdout'))
      child.stderr?.on('data', collect('stderr'))
      child.once('close', (code, signal) => {
        if (!started) return
        if (this.child === child) this.child = null
        if (timer) clearTimeout(timer)
        flush() // what's left, before saying it ended
        send({ type: 'exit', code, signal: signal ?? undefined, ms: Date.now() - startedAt })
      })
    })
  }

  sendInput(text: string): void {
    this.child?.stdin?.write(text)
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
  }

  get running(): boolean {
    return this.child !== null
  }
}
