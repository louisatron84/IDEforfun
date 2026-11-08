/**
 * Updates: is there a newer Forge on GitHub Releases, and getting it.
 *
 * Like VS Code: with "Keep Forge up to date" on (Settings → Updates, the
 * default), the installed app (Setup installer, AppImage) downloads a new
 * version in the background and installs it when Forge closes. The status
 * bar offers "Restart now" meanwhile. After the update, the first start shows
 * the release notes on the Welcome page. The portable version and the .deb
 * can't replace themselves: they say a new version exists and open the
 * download page.
 */
import { app, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateState } from '../shared/api'
import { isNewer, shouldShowWhatsNew } from '../shared/releaseNotes'

export { isNewer }

export const RELEASES = { owner: 'louisatron84', repo: 'IDEforfun' }
export const RELEASES_PAGE = `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/latest`

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

/** A release's notes by version (for "What's new" when they weren't saved at download), or null. */
export async function releaseNotesFor(version: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASES.owner}/${RELEASES.repo}/releases/tags/v${version}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Forge-update-check' }
  })
  if (!res.ok) return null
  const r = (await res.json()) as { body?: unknown }
  return typeof r.body === 'string' ? r.body.slice(0, 8000) : null
}

/** Can this copy replace itself? The installed Windows app and the Linux AppImage (not portable, .deb or from source). */
export function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') return !process.env['PORTABLE_EXECUTABLE_DIR']
  return process.platform === 'linux' && !!process.env['APPIMAGE']
}

const NOTES_FILE = 'update-notes.json'
const LAST_RUN_FILE = 'last-run-version.txt'

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
    // electron-updater is CommonJS: in the bundled app the import comes back wrapped under `default`.
    const mod = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') }
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!autoUpdater) throw new Error('The updater could not be loaded.')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('download-progress', (p) => this.set({ ...this.base(), kind: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', () => {
      const b = this.base()
      // Kept for "What's new" on the first start of the new version.
      if (b.latest) void writeFile(this.file(NOTES_FILE), JSON.stringify({ version: b.latest, notes: b.notes ?? '' }), 'utf8').catch(() => {})
      this.set({ ...b, kind: 'ready' })
    })
    autoUpdater.on('error', (err) => this.set({ ...this.base(), kind: 'error', message: err instanceof Error ? err.message : String(err) }))
    this.updater = autoUpdater
    return autoUpdater
  }

  private base() {
    const s = this.state
    return { current: app.getVersion(), latest: 'latest' in s ? s.latest : undefined, notes: 'notes' in s ? s.notes : undefined, url: 'url' in s ? s.url : RELEASES_PAGE }
  }

  /**
   * Look for a newer version. `manual`: the user asked (so "you're up to date"
   * is worth saying). `auto`: download it straight away (it installs when Forge closes).
   */
  async check(manual: boolean, auto = false): Promise<UpdateState> {
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
      if (selfUpdate && auto && !manual) await this.download()
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

  private file(name: string): string {
    return join(app.getPath('userData'), name)
  }

  /**
   * On the first start after an update: this version and its release notes
   * (saved at download, else fetched), once. Null otherwise, and on a first install.
   */
  async whatsNew(): Promise<{ version: string; notes: string } | null> {
    const current = app.getVersion()
    const last = await readFile(this.file(LAST_RUN_FILE), 'utf8').then((t) => t.trim() || null, () => null)
    if (last !== current) await writeFile(this.file(LAST_RUN_FILE), current, 'utf8').catch(() => {})
    if (!shouldShowWhatsNew(last, current)) return null
    return { version: current, notes: await this.notesFor(current) }
  }

  /** This (or another) version's release notes: saved at download, else from GitHub. */
  async notesFor(version: string): Promise<string> {
    const saved = await readFile(this.file(NOTES_FILE), 'utf8').then((t) => JSON.parse(t) as { version?: unknown; notes?: unknown }, () => null)
    if (saved && saved.version === version && typeof saved.notes === 'string' && saved.notes.trim()) return saved.notes
    return (await releaseNotesFor(version).catch(() => null)) ?? ''
  }

  /** Close and run the downloaded installer (it reopens Forge). */
  install(): void {
    // Silently, like the install when Forge closes; then Forge opens again.
    if (this.state.kind === 'ready' && this.updater) this.updater.quitAndInstall(true, true)
  }
}
