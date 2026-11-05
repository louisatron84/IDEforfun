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
import { win32 } from 'node:path'
import type { WebContents } from 'electron'
import type { ShellProfile, TerminalEvent } from '../shared/api'

export function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: env.SHELL || '/bin/bash', args: ['-l'] }
}

/**
 * Shells installed on this machine, default first. `exists` checks a path
 * (injected so this can be tested anywhere).
 */
export function findShells(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean
): ShellProfile[] {
  const out: ShellProfile[] = []
  const add = (id: string, name: string, file: string, args: string[]) => {
    if (!out.some((s) => s.id === id)) out.push({ id, name, file, args })
  }
  if (platform === 'win32') {
    const join = win32.join
    const sysRoot = env.SystemRoot || env.windir || join('C:', 'Windows')
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean) as string[]
    add('powershell', 'PowerShell', 'powershell.exe', ['-NoLogo'])
    for (const pf of programFiles) {
      const pwsh = join(pf, 'PowerShell', '7', 'pwsh.exe')
      if (exists(pwsh)) add('pwsh', 'PowerShell 7', pwsh, ['-NoLogo'])
    }
    add('cmd', 'Command Prompt', join(sysRoot, 'System32', 'cmd.exe'), [])
    for (const pf of programFiles) {
      const bash = join(pf, 'Git', 'bin', 'bash.exe')
      if (exists(bash)) add('gitbash', 'Git Bash', bash, ['--login', '-i'])
    }
    const wsl = join(sysRoot, 'System32', 'wsl.exe')
    if (exists(wsl)) add('wsl', 'WSL', wsl, [])
    return out
  }
  if (env.SHELL) add(env.SHELL.split('/').pop()!, env.SHELL.split('/').pop()!, env.SHELL, ['-l'])
  for (const [name, paths] of [
    ['bash', ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash']],
    ['zsh', ['/bin/zsh', '/usr/bin/zsh']],
    ['fish', ['/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish']]
  ] as const) {
    const found = paths.find(exists)
    if (found) add(name, name, found, ['-l'])
  }
  if (!out.length) add('sh', 'sh', '/bin/sh', [])
  return out
}

export class Terminals {
  private readonly terms = new Map<number, pty.IPty>()
  private nextId = 1

  /** Installed shells, default first. */
  shells(): ShellProfile[] {
    return findShells(process.platform, process.env, existsSync)
  }

  /** Start a shell (`profileId` from shells(); default if missing or unknown). Returns its id. */
  create(sender: WebContents, cwd: string | null, cols: number, rows: number, profileId?: string): number {
    const id = this.nextId++
    const shell = this.shells().find((s) => s.id === profileId) ?? defaultShell(process.platform, process.env)
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
