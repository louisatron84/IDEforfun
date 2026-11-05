/**
 * Running Python files for the "Run" command.
 *
 * Picks an interpreter (the project's virtualenv if it has one, otherwise
 * python on PATH), runs the file unbuffered so output appears live, and
 * streams stdout/stderr back to the window that asked.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { win32, posix } from 'node:path'
import type { WebContents } from 'electron'
import type { RunEventBody } from '../shared/api'

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

  async run(sender: WebContents, file: string, cwd: string, configured?: string): Promise<void> {
    this.stop()
    // Every event carries the run's id, so the window can ignore late events
    // from a previous run (e.g. its "exited" message after a restart).
    const runId = ++this.runId
    const send = (e: RunEventBody) => {
      if (!sender.isDestroyed()) sender.send('run:event', { ...e, runId })
    }

    // An interpreter chosen in Settings is used as-is: if it's wrong, say so rather
    // than quietly running some other Python.
    const candidates = configured ? [configured] : pythonCandidates(cwd, process.platform)
    for (const python of candidates) {
      // Paths (virtualenvs) must exist; bare commands are found on PATH by spawn.
      if (!isBareCommand(python)) {
        try {
          await access(python)
        } catch {
          continue
        }
      }
      const started = await this.trySpawn(python, file, cwd, send)
      if (started) return
    }
    send({
      type: 'error',
      message: configured
        ? `The Python interpreter set in Settings wasn't found:\n  ${configured}\nFix it in Settings (Ctrl+,), or clear it to pick one automatically.`
        : 'Python was not found. Install it from python.org, or create a .venv in your project.'
    })
    send({ type: 'exit', code: null, ms: 0 })
  }

  /** Resolves true once the process has started, false if this interpreter doesn't exist. */
  private trySpawn(python: string, file: string, cwd: string, send: (e: RunEventBody) => void): Promise<boolean> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const child = spawn(python, ['-u', file], {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
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
      child.stdout?.on('data', (text: string) => send({ type: 'output', stream: 'stdout', text }))
      child.stderr?.on('data', (text: string) => send({ type: 'output', stream: 'stderr', text }))
      child.once('close', (code, signal) => {
        if (!started) return
        if (this.child === child) this.child = null
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
