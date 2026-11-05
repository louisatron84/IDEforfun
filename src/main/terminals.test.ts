import { describe, expect, it } from 'vitest'
import { findShells } from './terminals'

describe('findShells', () => {
  it('Windows: PowerShell first, then whatever else is installed', () => {
    const installed = new Set([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ])
    const shells = findShells('win32', { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, (p) => installed.has(p))
    expect(shells.map((s) => s.name)).toEqual(['PowerShell', 'PowerShell 7', 'Command Prompt', 'Git Bash'])
    expect(shells.find((s) => s.id === 'cmd')?.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(shells.find((s) => s.id === 'gitbash')?.args).toEqual(['--login', '-i'])
  })
  it('Windows: WSL when present', () => {
    const shells = findShells('win32', { SystemRoot: 'C:\\Windows' }, (p) => p === 'C:\\Windows\\System32\\wsl.exe')
    expect(shells.map((s) => s.id)).toEqual(['powershell', 'cmd', 'wsl'])
  })
  it('macOS/Linux: the login shell first, then other installed ones', () => {
    const installed = new Set(['/bin/bash', '/bin/zsh'])
    const shells = findShells('darwin', { SHELL: '/bin/zsh' }, (p) => installed.has(p))
    expect(shells.map((s) => s.id)).toEqual(['zsh', 'bash'])
  })
  it('falls back to sh', () => {
    expect(findShells('linux', {}, () => false).map((s) => s.file)).toEqual(['/bin/sh'])
  })
})
