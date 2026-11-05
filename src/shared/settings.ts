/** User settings, saved as JSON in the app's data folder. */

export interface Settings {
  fontSize: number
  theme: 'dark' | 'light'
  tabSize: 2 | 4 | 8
  /** Python interpreter to use for Run; '' = automatic (project .venv, then PATH). */
  pythonPath: string
  /** Shell for new terminals (an id like 'powershell', 'gitbash'); '' = the system default. */
  shell: string
  /** Open the last project again when the app starts. */
  reopenLastProject: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  theme: 'dark',
  tabSize: 4,
  pythonPath: '',
  shell: '',
  reopenLastProject: true
}

export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 28

/** Turn anything (e.g. a hand-edited or corrupt settings file) into valid settings. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const s: Settings = { ...DEFAULT_SETTINGS }
  if (typeof r.fontSize === 'number' && Number.isFinite(r.fontSize)) {
    s.fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(r.fontSize)))
  }
  if (r.theme === 'dark' || r.theme === 'light') s.theme = r.theme
  if (r.tabSize === 2 || r.tabSize === 4 || r.tabSize === 8) s.tabSize = r.tabSize
  if (typeof r.pythonPath === 'string') s.pythonPath = r.pythonPath.trim()
  if (typeof r.shell === 'string' && /^[\w.-]*$/.test(r.shell)) s.shell = r.shell
  if (typeof r.reopenLastProject === 'boolean') s.reopenLastProject = r.reopenLastProject
  return s
}

/** Settings a project can override in <project>/.ideforfun/settings.json. */
export const PROJECT_SETTING_KEYS = ['tabSize', 'pythonPath', 'shell'] as const
export type ProjectSettings = Partial<Pick<Settings, (typeof PROJECT_SETTING_KEYS)[number]>>

export const PROJECT_SETTINGS_DIR = '.ideforfun'
export const PROJECT_SETTINGS_FILE = 'settings.json'

/** Only the valid project-level values from a project settings file; anything else is ignored. */
export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: ProjectSettings = {}
  if (r.tabSize === 2 || r.tabSize === 4 || r.tabSize === 8) out.tabSize = r.tabSize
  if (typeof r.pythonPath === 'string') out.pythonPath = r.pythonPath.trim()
  if (typeof r.shell === 'string' && /^[\w.-]*$/.test(r.shell)) out.shell = r.shell
  return out
}

/** The settings in effect: yours, with the project's overrides on top. */
export function effectiveSettings(user: Settings, project: ProjectSettings): Settings {
  return { ...user, ...project }
}
