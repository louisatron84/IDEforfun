import { describe, expect, it } from 'vitest'
import { LanguageServers, SERVERS, unpackedPath } from './languageServer'
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

describe('unpackedPath (installed app)', () => {
  it('points a module inside app.asar at its unpacked copy', () => {
    expect(unpackedPath(String.raw`C:\Program Files\Forge\resources\app.asar\node_modules\pyright\langserver.index.js`))
      .toBe(String.raw`C:\Program Files\Forge\resources\app.asar.unpacked\node_modules\pyright\langserver.index.js`)
    expect(unpackedPath('/opt/Forge/resources/app.asar/node_modules/pyright/langserver.index.js'))
      .toBe('/opt/Forge/resources/app.asar.unpacked/node_modules/pyright/langserver.index.js')
  })

  it('leaves other paths alone (running from source)', () => {
    const dev = String.raw`C:\Users\me\IDEforfun\node_modules\pyright\langserver.index.js`
    expect(unpackedPath(dev)).toBe(dev)
    expect(unpackedPath('/x/app.asar.unpacked/y.js')).toBe('/x/app.asar.unpacked/y.js')
  })
})
