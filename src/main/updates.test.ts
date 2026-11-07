import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.46.0' }, shell: { openExternal: vi.fn() } }))

const { isNewer, latestRelease, canSelfUpdate } = await import('./updates')

describe('isNewer', () => {
  it('compares versions number by number', () => {
    expect(isNewer('0.45.0', '0.46.0')).toBe(true)
    expect(isNewer('0.46.0', '0.46.0')).toBe(false)
    expect(isNewer('0.46.0', '0.45.9')).toBe(false)
    expect(isNewer('1.2.9', '1.2.10')).toBe(true)
    expect(isNewer('v0.46.0', 'v0.47.0')).toBe(true)
    expect(isNewer('0.46', '0.46.1')).toBe(true)
  })
  it('a pre-release is older than its release', () => {
    expect(isNewer('0.47.0-beta.1', '0.47.0')).toBe(true)
    expect(isNewer('0.47.0', '0.47.0-beta.2')).toBe(false)
  })
})

describe('latestRelease', () => {
  it('reads the newest release from GitHub', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v0.47.0', body: 'New things', html_url: 'https://github.com/x/releases/v0.47.0' }), { status: 200 }))
    expect(await latestRelease(fetchImpl as unknown as typeof fetch)).toEqual({ version: '0.47.0', notes: 'New things', url: 'https://github.com/x/releases/v0.47.0' })
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe('https://api.github.com/repos/louisatron84/IDEforfun/releases/latest')
  })
  it('nothing for errors, drafts and pre-releases', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect(await latestRelease(reply(404, {}))).toBeNull()
    expect(await latestRelease(reply(200, { tag_name: 'v1.0.0', prerelease: true }))).toBeNull()
    expect(await latestRelease(reply(200, { tag_name: 'v1.0.0', draft: true }))).toBeNull()
  })
})

describe('canSelfUpdate', () => {
  it('not when running from source', () => {
    expect(canSelfUpdate()).toBe(false)
  })
})
