/**
 * Updates: is there a newer Forge on GitHub Releases, and getting it.
 *
 * The installed app (the Setup installer) updates itself with
 * electron-updater: it asks first, downloads in the background, then
 * "Restart to update". The portable version, and a copy run from source,
 * can't replace themselves: they only say a new version exists and open the
 * download page. Nothing is checked or downloaded without the user's say
 * (a check on start can be turned off in Settings).
 */
import { app, shell } from 'electron'
import type { UpdateState } from '../shared/api'

export const RELEASES = { owner: 'louisatron84', repo: 'IDEforfun' }
export const RELEASES_PAGE = `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/latest`

/** Is `latest` newer than `current`? (1.2.10 > 1.2.9; a leading v is ignored; pre-releases are older than the release.) */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/i, '').split('-', 2)
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null }
  }
  const a = parse(current)
  const b = parse(latest)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const x = a.nums[i] ?? 0
    const y = b.nums[i] ?? 0
    if (x !== y) return y > x
  }
  if (a.pre && !b.pre) return true
  if (!a.pre && b.pre) return false
  return !!a.pre && !!b.pre && b.pre > a.pre
}

/** The newest published release on GitHub (no drafts or pre-releases), or null. */
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<{ version: string; notes: string; url: string } | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASES.owner}/${RELEASES.repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Forge-update-check' }
  })
  if (!res.ok) return null
  const r = (await res.json()) as { tag_name?: unknown; body?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
  if (typeof r.tag_name !== 'string' || r.draft || r.prerelease) return null
  return { version: r.tag_name.replace(/^v/i, ''), notes: typeof r.body === 'string' ? r.body.slice(0, 4000) : '', url: typeof r.html_url === 'string' ? r.html_url : RELEASES_PAGE }
}

/** Can this copy replace itself? Only the installed Windows app (not portable, not from source). */
export function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform === 'win32' && !process.env['PORTABLE_EXECUTABLE_DIR']
}

export class Updates {
  private state: UpdateState = { kind: 'idle', current: app.getVersion() }
  private updater: typeof import('electron-updater').autoUpdater | null = null

  constructor(private readonly send: (state: UpdateState) => void) {}

  get current(): UpdateState {
    return this.state
  }

  private set(state: UpdateState): void {
    this.state = state
    this.send(state)
  }

  private async getUpdater() {
    if (this.updater) return this.updater
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('download-progress', (p) => this.set({ ...this.base(), kind: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', () => this.set({ ...this.base(), kind: 'ready' }))
    autoUpdater.on('error', (err) => this.set({ ...this.base(), kind: 'error', message: err instanceof Error ? err.message : String(err) }))
    this.updater = autoUpdater
    return autoUpdater
  }

  private base() {
    const s = this.state
    return { current: app.getVersion(), latest: 'latest' in s ? s.latest : undefined, notes: 'notes' in s ? s.notes : undefined, url: 'url' in s ? s.url : RELEASES_PAGE }
  }

  /** Look for a newer version. `manual`: the user asked (so "you're up to date" is worth saying). */
  async check(manual: boolean): Promise<UpdateState> {
    if (this.state.kind === 'downloading' || this.state.kind === 'ready') return this.state
    this.set({ kind: 'checking', current: app.getVersion(), manual })
    try {
      const release = await latestRelease()
      if (!release || !isNewer(app.getVersion(), release.version)) {
        this.set({ kind: 'none', current: app.getVersion(), manual })
        return this.state
      }
      const selfUpdate = canSelfUpdate()
      if (selfUpdate) {
        // The installer's own check (reads latest.yml from the release).
        const updater = await this.getUpdater()
        await updater.checkForUpdates()
      }
      this.set({ kind: 'available', current: app.getVersion(), latest: release.version, notes: release.notes, url: release.url, selfUpdate, manual })
    } catch (err) {
      this.set({ kind: 'error', current: app.getVersion(), message: err instanceof Error ? err.message : String(err), manual })
    }
    return this.state
  }

  /** Installed app: download it (progress, then "ready"). Otherwise: open the download page. */
  async download(): Promise<void> {
    if (!canSelfUpdate()) {
      await shell.openExternal('url' in this.state && this.state.url ? this.state.url : RELEASES_PAGE)
      return
    }
    const updater = await this.getUpdater()
    this.set({ ...this.base(), kind: 'downloading', percent: 0 })
    try {
      await updater.downloadUpdate()
    } catch (err) {
      this.set({ ...this.base(), kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Close and run the downloaded installer (it reopens Forge). */
  install(): void {
    if (this.state.kind === 'ready' && this.updater) this.updater.quitAndInstall(false, true)
  }
}
