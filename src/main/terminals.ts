/**
 * Integrated terminal processes.
 *
 * Each terminal is a real shell running in a pseudo-terminal (node-pty), so
 * interactive programs, colors and line editing work like in a normal
 * terminal window. The renderer draws it with xterm.js.
 */
import * as pty from 'node-pty'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { WebContents } from 'electron'
import type { TerminalEvent } from '../shared/api'

export function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: env.SHELL || '/bin/bash', args: ['-l'] }
}

export class Terminals {
  private readonly terms = new Map<number, pty.IPty>()
  private nextId = 1

  create(sender: WebContents, cwd: string | null, cols: number, rows: number): number {
    const id = this.nextId++
    const shell = defaultShell(process.platform, process.env)
    const term = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      env: { ...process.env, TERM_PROGRAM: 'IDEforfun' } as Record<string, string>
    })
    const send = (e: TerminalEvent) => {
      if (!sender.isDestroyed()) sender.send('term:event', e)
    }
    term.onData((data) => send({ type: 'data', id, data }))
    term.onExit(({ exitCode }) => {
      this.terms.delete(id)
      send({ type: 'exit', id, code: exitCode })
    })
    this.terms.set(id, term)
    return id
  }

  write(id: number, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: number, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows))
    } catch {
      // the process may have just exited
    }
  }

  kill(id: number): void {
    const t = this.terms.get(id)
    this.terms.delete(id)
    try {
      t?.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}
