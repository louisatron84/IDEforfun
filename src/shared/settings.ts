/** User settings, saved as JSON in the app's data folder. */

export interface Settings {
  fontSize: number
  theme: 'dark' | 'light'
  tabSize: 2 | 4 | 8
  /** Python interpreter to use for Run; '' = automatic (project .venv, then PATH). */
  pythonPath: string
  /** Shell for new terminals (an id like 'powershell', 'gitbash'); '' = the system default. */
  shell: string
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  theme: 'dark',
  tabSize: 4,
  pythonPath: '',
  shell: ''
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
  return s
}
