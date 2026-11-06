import { describe, expect, it } from 'vitest'
import { LanguageServers, SERVERS } from './languageServer'
import { LANGUAGES } from '../shared/languages'

describe('LanguageServers', () => {
  it('refuses server ids that are not in the registry (the window cannot start arbitrary commands)', () => {
    const servers = new LanguageServers()
    const sender = {} as never
    expect(() => servers.start('nope', sender)).toThrow(/Unknown language server/)
    expect(() => servers.start('constructor', sender)).toThrow(/Unknown language server/)
    expect(() => servers.start('__proto__', sender)).toThrow(/Unknown language server/)
  })

  it('every language that names a server has it in the registry', () => {
    for (const lang of LANGUAGES) if (lang.server) expect(Object.hasOwn(SERVERS, lang.server)).toBe(true)
  })

  it('sending to or stopping a server that is not running does nothing', () => {
    const servers = new LanguageServers()
    expect(() => servers.send('pyright', { jsonrpc: '2.0' })).not.toThrow()
    expect(() => servers.stop('pyright')).not.toThrow()
    expect(() => servers.stop()).not.toThrow()
  })
})
