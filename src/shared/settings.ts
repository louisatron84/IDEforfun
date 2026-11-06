/** User settings, saved as JSON in the app's data folder. */

/** Molten: Forge's own colours. Plain: black and white, high contrast. */
export type ThemeName = 'molten' | 'plain'

export interface Settings {
  fontSize: number
  theme: ThemeName
  tabSize: 2 | 4 | 8
  /** Python interpreter to use for Run; '' = automatic (project .venv, then PATH). */
  pythonPath: string
  /** Shell for new terminals (an id like 'powershell', 'gitbash'); '' = the system default. */
  shell: string
  /** Open the last project again when the app starts. */
  reopenLastProject: boolean
  /** Show the Welcome page when no files are open. */
  showWelcome: boolean
  /** Formatter for Format Document: 'auto' = Ruff if installed, else Black. */
  formatter: 'auto' | 'ruff' | 'black'
  /** Format Python files when saving them. */
  formatOnSave: boolean
  /** Show Ruff's lint warnings (when Ruff is installed). */
  lintWithRuff: boolean
  /** Run the program being debugged in a terminal (so input() works) instead of the Debug console. */
  debugInTerminal: boolean
  /** Switch to the Debug task while debugging (and back afterwards). */
  switchToDebugTask: boolean
  /** While a program runs with the Graph in view, show where it's at. */
  showRunsOnGraph: boolean
  /** How much fits in the panels: smaller and tighter, or larger and roomier (the editor and terminal follow the font size). */
  density: 'compact' | 'normal' | 'roomy'
  /** Animate switching tasks and moving panels (always off when the system asks for reduced motion). */
  animations: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  theme: 'molten',
  tabSize: 4,
  pythonPath: '',
  shell: '',
  reopenLastProject: true,
  showWelcome: true,
  formatter: 'auto',
  formatOnSave: false,
  lintWithRuff: true,
  debugInTerminal: true,
  switchToDebugTask: true,
  showRunsOnGraph: true,
  density: 'normal',
  animations: true
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
  if (r.theme === 'molten' || r.theme === 'plain') s.theme = r.theme
  // Settings from before Forge: dark became Molten, light became Plain.
  else if (r.theme === 'dark') s.theme = 'molten'
  else if (r.theme === 'light') s.theme = 'plain'
  if (r.tabSize === 2 || r.tabSize === 4 || r.tabSize === 8) s.tabSize = r.tabSize
  if (typeof r.pythonPath === 'string') s.pythonPath = r.pythonPath.trim()
  if (typeof r.shell === 'string' && /^[\w.-]*$/.test(r.shell)) s.shell = r.shell
  if (typeof r.reopenLastProject === 'boolean') s.reopenLastProject = r.reopenLastProject
  if (typeof r.showWelcome === 'boolean') s.showWelcome = r.showWelcome
  if (r.formatter === 'auto' || r.formatter === 'ruff' || r.formatter === 'black') s.formatter = r.formatter
  if (typeof r.formatOnSave === 'boolean') s.formatOnSave = r.formatOnSave
  if (typeof r.lintWithRuff === 'boolean') s.lintWithRuff = r.lintWithRuff
  if (typeof r.debugInTerminal === 'boolean') s.debugInTerminal = r.debugInTerminal
  if (typeof r.switchToDebugTask === 'boolean') s.switchToDebugTask = r.switchToDebugTask
  if (typeof r.showRunsOnGraph === 'boolean') s.showRunsOnGraph = r.showRunsOnGraph
  if (r.density === 'compact' || r.density === 'normal' || r.density === 'roomy') s.density = r.density
  if (typeof r.animations === 'boolean') s.animations = r.animations
  return s
}

/** Settings a project can override in <project>/.forge/settings.json. */
export const PROJECT_SETTING_KEYS = ['tabSize', 'pythonPath', 'shell', 'formatter', 'formatOnSave', 'lintWithRuff'] as const
export type ProjectSettings = Partial<Pick<Settings, (typeof PROJECT_SETTING_KEYS)[number]>>

/** The project's own Forge files (settings.json, run.json…). */
export const PROJECT_DIR = '.forge'
/** Where they lived before the rename to Forge (moved on first open, see src/main/projectDir.ts). */
export const LEGACY_PROJECT_DIR = '.ideforfun'
export const PROJECT_SETTINGS_FILE = 'settings.json'

/** Only the valid project-level values from a project settings file; anything else is ignored. */
export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: ProjectSettings = {}
  if (r.tabSize === 2 || r.tabSize === 4 || r.tabSize === 8) out.tabSize = r.tabSize
  if (typeof r.pythonPath === 'string') out.pythonPath = r.pythonPath.trim()
  if (typeof r.shell === 'string' && /^[\w.-]*$/.test(r.shell)) out.shell = r.shell
  if (r.formatter === 'auto' || r.formatter === 'ruff' || r.formatter === 'black') out.formatter = r.formatter
  if (typeof r.formatOnSave === 'boolean') out.formatOnSave = r.formatOnSave
  if (typeof r.lintWithRuff === 'boolean') out.lintWithRuff = r.lintWithRuff
  return out
}

/** The settings in effect: yours, with the project's overrides on top. */
export function effectiveSettings(user: Settings, project: ProjectSettings): Settings {
  return { ...user, ...project }
}
