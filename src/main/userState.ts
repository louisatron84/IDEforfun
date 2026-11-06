/**
 * Small JSON files the app keeps between sessions (in the app's data folder):
 *   keybindings.json      your keyboard shortcut changes
 *   layouts.json          your workspace arrangement for each task
 *   recent.json           recently opened folders
 *   workspaces/<id>.json  each project's tabs, layout and terminals
 * and the project's own <project>/.forge/settings.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeKeybindings, type KeyOverrides } from '../shared/keybindings'
import { normalizeLayouts, type SavedLayouts } from '../shared/layouts'
import { addRecent, normalizeRecent, normalizeWorkspaceState, removeRecent, type WorkspaceState } from '../shared/projectState'
import { normalizeProjectSettings, PROJECT_DIR, PROJECT_SETTINGS_FILE, type ProjectSettings } from '../shared/settings'
import { backupName } from './backups'

/** Parsed JSON, or why it couldn't be read. A missing file is `{ missing: true }`. */
async function readJson(path: string): Promise<{ value?: unknown; error?: string; missing?: boolean }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    return { error: String(err) }
  }
  if (!text.trim()) return { value: {} }
  try {
    return { value: JSON.parse(text) }
  } catch (err) {
    return { error: `It isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export class UserState {
  constructor(private readonly dir: () => string) {}

  get keybindingsPath(): string {
    return join(this.dir(), 'keybindings.json')
  }

  async keybindings(): Promise<{ overrides: KeyOverrides; path: string; error?: string }> {
    const path = this.keybindingsPath
    const res = await readJson(path)
    return { overrides: normalizeKeybindings(res.value), path, error: res.error }
  }

  /** Save shortcut changes ([] is written as null: "no shortcut"). */
  async saveKeybindings(overrides: KeyOverrides): Promise<void> {
    const clean = normalizeKeybindings(overrides)
    const out: Record<string, string | string[] | null> = {}
    for (const id of Object.keys(clean).sort()) {
      const keys = clean[id]
      out[id] = keys.length === 0 ? null : keys.length === 1 ? keys[0] : keys
    }
    await writeJson(this.keybindingsPath, out)
  }

  /** Workspace arrangements per task (layouts.json); a bad or missing file means the defaults. */
  async layouts(): Promise<SavedLayouts> {
    return normalizeLayouts((await readJson(join(this.dir(), 'layouts.json'))).value)
  }

  async saveLayouts(layouts: unknown): Promise<void> {
    await writeJson(join(this.dir(), 'layouts.json'), normalizeLayouts(layouts))
  }

  /** Create keybindings.json if needed (for editing it by hand). */
  async ensureKeybindingsFile(): Promise<string> {
    const path = this.keybindingsPath
    if ((await readJson(path)).missing) await writeJson(path, {})
    return path
  }

  private get recentPath(): string {
    return join(this.dir(), 'recent.json')
  }

  async recent(): Promise<string[]> {
    return normalizeRecent((await readJson(this.recentPath)).value)
  }

  async addRecent(folder: string): Promise<string[]> {
    const list = addRecent(await this.recent(), folder)
    await writeJson(this.recentPath, list)
    return list
  }

  async removeRecent(folder: string): Promise<string[]> {
    const list = removeRecent(await this.recent(), folder)
    await writeJson(this.recentPath, list)
    return list
  }

  async clearRecent(): Promise<void> {
    await writeJson(this.recentPath, [])
  }

  private workspacePath(root: string): string {
    return join(this.dir(), 'workspaces', backupName(root))
  }

  async workspace(root: string): Promise<WorkspaceState | null> {
    const res = await readJson(this.workspacePath(root))
    return res.value === undefined ? null : normalizeWorkspaceState(res.value)
  }

  /** Synchronous, so it still happens while the window is closing. */
  saveWorkspaceSync(root: string, state: unknown): void {
    const path = this.workspacePath(root)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(normalizeWorkspaceState(state)), 'utf8')
  }

  /** Synchronous so the menu can be built from it at startup. */
  recentSync(): string[] {
    try {
      return normalizeRecent(JSON.parse(readFileSync(this.recentPath, 'utf8')))
    } catch {
      return []
    }
  }
}

export function projectSettingsPath(root: string): string {
  return join(root, PROJECT_DIR, PROJECT_SETTINGS_FILE)
}

/** The project's settings overrides; an unreadable file is reported, not fatal. */
export async function readProjectSettings(root: string): Promise<{ settings: ProjectSettings; path: string; exists: boolean; error?: string }> {
  const path = projectSettingsPath(root)
  const res = await readJson(path)
  return { settings: normalizeProjectSettings(res.value), path, exists: !res.missing, error: res.error }
}

/** Files the window may read or create in <project>/.forge (nothing else). */
const PROJECT_FILES = new Set(['run.json'])

/** A project file's JSON (missing = exists false, unreadable = error). */
export async function readProjectFile(root: string, name: string): Promise<{ value: unknown; path: string; exists: boolean; error?: string }> {
  if (!PROJECT_FILES.has(name)) throw new Error(`Not a project file: ${name}`)
  const path = join(root, PROJECT_DIR, name)
  const res = await readJson(path)
  return { value: res.value, path, exists: !res.missing, error: res.error }
}

export async function ensureProjectFile(root: string, name: string, initial: unknown): Promise<string> {
  if (!PROJECT_FILES.has(name)) throw new Error(`Not a project file: ${name}`)
  const path = join(root, PROJECT_DIR, name)
  if ((await readJson(path)).missing) await writeJson(path, initial)
  return path
}

/** Change some values in the project settings file, keeping everything else in it. */
export async function updateProjectSettings(root: string, patch: Record<string, unknown>): Promise<void> {
  const path = projectSettingsPath(root)
  const res = await readJson(path)
  if (res.error) throw new Error(`${path} can't be updated: ${res.error}`)
  const current = res.value && typeof res.value === 'object' && !Array.isArray(res.value) ? { ...(res.value as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete current[k]
    else current[k] = v
  }
  await writeJson(path, current)
}

/** Create the project settings file (with `initial` in it) if it doesn't exist yet. */
export async function ensureProjectSettings(root: string, initial: ProjectSettings): Promise<string> {
  const path = projectSettingsPath(root)
  if ((await readJson(path)).missing) await writeJson(path, initial)
  return path
}
