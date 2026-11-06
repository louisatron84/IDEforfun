import type { ProjectSettings, Settings } from './settings'
import type { KeyOverrides } from './keybindings'
import type { WorkspaceState } from './projectState'
import type { TestFile } from './tests'
import type { FindOptions } from './regex'
import type { Encoding, TextFileResult } from './encoding'

/** What a tool (Ruff / Black) gave back: its output, or why it couldn't run. */
export interface ToolResult {
  ok: boolean
  output: string
  error?: string
  /** The tool isn't installed. */
  missing?: boolean
}

/** Which tests to run, and how. */
export interface TestRunRequest {
  python: string
  root: string
  framework: 'pytest' | 'unittest'
  /** pytest node ids or unittest ids; empty = all. */
  ids: string[]
}

export interface TestRunResult {
  exitCode: number | null
  output: string
  /** pytest's JUnit XML report. */
  xml?: string
  seconds: number
  error?: string
}

/** A Python interpreter that was found and runs. */
export interface InterpreterInfo {
  /** Full path of the executable (sys.executable). */
  path: string
  version: string
  /** A virtual environment (venv / virtualenv). */
  isVenv: boolean
  /** sys.prefix: the environment's folder. */
  prefix: string
}

/** What to run: a script or module, with arguments, environment and working folder. */
export interface RunSpec {
  /** The project folder (where a .venv is looked for). */
  root: string
  program: string | null
  module: string | null
  args: string[]
  env: Record<string, string>
  cwd: string
  /** Interpreter from Settings; empty = automatic. */
  python?: string
}

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

/** Messages streamed from a running Python program to the window. */
export type RunEventBody =
  | { type: 'start'; python: string; file: string }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null; signal?: string; ms: number }

export type RunEvent = RunEventBody & { runId: number }

/** Messages from an integrated terminal's shell. */
export type TerminalEvent =
  | { type: 'data'; id: number; data: string }
  | { type: 'exit'; id: number; code: number }

export interface ProjectSearchResult {
  files: {
    path: string
    rel: string
    matches: { line: number; col: number; length: number; preview: { text: string; start: number } }[]
  }[]
  total: number
  truncated: boolean
  /** Files not searched because they're too big (relative paths). */
  skipped: string[]
  error?: string
}

export type GitState = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflict'

/** Changed files (absolute paths) and the folders that contain them. */
export interface GitStatusMap {
  files: Record<string, GitState>
  folders: string[]
}

/** The only bridge between the UI (renderer) and the OS (main process). */
/** A copy of an unsaved file, kept until it's saved (for crash recovery). */
export interface BackupData {
  path: string
  text: string
  encoding: Encoding
  eol: 'LF' | 'CRLF'
  /** When the backup was written (ms since 1970). */
  time: number
}

/** A shell the integrated terminal can run. */
export interface ShellProfile {
  id: string
  name: string
  file: string
  args: string[]
}

export interface IdeApi {
  /** Show the folder picker: the folder, null if cancelled, or why it can't be opened. */
  openFolder(): Promise<string | { error: string } | null>
  /** Save dialog for a new file anywhere; creates it empty. null = cancelled. */
  newFileDialog(): Promise<string | { error: string } | null>
  /** Pick the folder a new project folder goes in. null = cancelled. */
  pickParentFolder(): Promise<string | { error: string } | null>
  /** Menu bar: run a command (an id from the keymap). */
  onMenuCommand(listener: (id: string) => void): () => void
  /** Menu bar: an Edit action (undo, copy, paste...). */
  onMenuEdit(listener: (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void): () => void
  /** Do an edit action natively in whatever has focus (text boxes; paste into the editor). */
  nativeEdit(action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void
  /** Ask "save changes to <name>?" (blocks until answered). */
  askUnsaved(name: string, detail?: string): 'save' | 'discard' | 'cancel'
  /** Check a typed folder path: the real path, or why it can't be opened. */
  checkFolder(path: string): Promise<string | { error: string }>
  /** The file-system path of a file/folder dropped onto the window ('' if none). */
  pathForFile(file: File): string
  readDir(path: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  /** Read a file for the editor: detects its encoding, and reports binary / huge files. */
  readTextFile(path: string, opts?: { force?: boolean; encoding?: Encoding }): Promise<TextFileResult>
  writeTextFile(path: string, text: string, encoding: Encoding): Promise<void>
  /** Crash recovery: keep / drop / list copies of unsaved files. */
  backupWrite(data: BackupData): Promise<void>
  backupRemove(path: string): Promise<void>
  backupList(): Promise<BackupData[]>
  /** Create an empty file or folder in `dir` ("pkg/mod.py" makes "pkg" too). Returns its path. */
  createEntry(dir: string, name: string, isDirectory: boolean): Promise<string>
  /** Rename in place; returns the new path. */
  renameEntry(path: string, newName: string): Promise<string>
  /** Move a file or folder to the Recycle Bin. */
  trashEntry(path: string): Promise<void>
  /** Delete for good (when there's no trash). */
  deletePermanently(path: string): Promise<void>

  /** Run a Python file (stops any program already running). */
  /** Run a Python file or module (Run / Ctrl+F5); output arrives as run events. */
  runPython(spec: RunSpec): Promise<number>
  stopRun(): Promise<void>
  /** Send text to the running program's stdin (for input()). */
  sendRunInput(text: string): Promise<void>
  /** Listen for output/exit events; returns a function that stops listening. */
  onRunEvent(listener: (event: RunEvent) => void): () => void

  /** Start a shell in a pseudo-terminal; returns its id. */
  terminalCreate(cwd: string | null, cols: number, rows: number, profileId?: string): Promise<number>
  /** Shells installed on this machine, default first. */
  terminalShells(): Promise<ShellProfile[]>
  terminalWrite(id: number, data: string): void
  terminalResize(id: number, cols: number, rows: number): void
  terminalKill(id: number): void
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void

  /** The interpreter to debug with, and whether debugpy is installed in it. */
  debugPrepare(cwd: string, python?: string): Promise<{ python: string | null; hasDebugpy: boolean }>
  /** pip install debugpy into that interpreter. */
  debugInstall(python: string): Promise<{ ok: boolean; output: string }>
  /** Start the debugpy adapter; then talk to it with debugSend / onDebugMessage (DAP). */
  debugStart(python: string, cwd: string): Promise<void>
  debugSend(message: unknown): void
  debugStop(): Promise<void>
  onDebugMessage(listener: (message: unknown) => void): () => void
  onDebugExit(listener: (info: { code: number | null; error?: string }) => void): () => void

  /** Every file under a folder (for quick open), skipping .git, node_modules, etc. */
  listFiles(root: string): Promise<{ path: string; rel: string }[]>

  /** Search every text file under `root` (Ctrl+Shift+F). */
  searchProject(root: string, query: string, opts: FindOptions): Promise<ProjectSearchResult>

  /** Git status of files under a folder; null if it isn't a git repository. */
  gitStatus(folder: string): Promise<GitStatusMap | null>

  /** Start (or restart) the Python language server. */
  lspStart(): Promise<void>
  /** Send a JSON-RPC message to the language server. */
  lspSend(message: unknown): void
  onLspMessage(listener: (message: unknown) => void): () => void
  onLspExit(listener: (code: number | null) => void): () => void
  /** The interpreter Pyright should analyse with (configured, or the project's venv). */
  resolvePythonForAnalysis(root: string, configured?: string): Promise<string | undefined>

  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>

  /** Your shortcut changes from keybindings.json (error = the file couldn't be read). */
  getKeybindings(): Promise<{ overrides: KeyOverrides; path: string; error?: string }>
  saveKeybindings(overrides: KeyOverrides): Promise<void>
  /** Create keybindings.json if needed; returns its path. */
  ensureKeybindingsFile(): Promise<string>
  /** Tell the menu bar which shortcut to show for each command. */
  setMenuKeys(keys: Record<string, string | null>): void

  /** Recently opened folders, newest first. */
  recentList(): Promise<string[]>
  recentAdd(folder: string): Promise<string[]>
  recentRemove(folder: string): Promise<string[]>
  recentClear(): Promise<string[]>
  onMenuOpenRecent(listener: (folder: string) => void): () => void

  /** The project's saved tabs/layout, or null the first time it's opened. */
  workspaceState(root: string): Promise<WorkspaceState | null>
  saveWorkspaceState(root: string, state: WorkspaceState): void
  /** <project>/.ideforfun/settings.json */
  projectSettings(root: string): Promise<{ settings: ProjectSettings; path: string; exists: boolean; error?: string }>
  /** Create the project settings file if needed; returns its path. */
  ensureProjectSettings(root: string, initial: ProjectSettings): Promise<string>
  /** Another file in <project>/.ideforfun (e.g. run.json): its JSON, or why it can't be read. */
  readProjectFile(root: string, name: string): Promise<{ value: unknown; path: string; exists: boolean; error?: string }>
  ensureProjectFile(root: string, name: string, initial: unknown): Promise<string>
  /** Set (or with undefined, remove) values in the project's .ideforfun/settings.json, keeping the rest. */
  updateProjectSettings(root: string, patch: Record<string, unknown>): Promise<void>

  /** Interpreters found in the project (venvs) and on this machine. */
  findInterpreters(root: string | null): Promise<InterpreterInfo[]>
  /** The interpreter Run would use, described (null if none works). */
  currentInterpreter(root: string, configured?: string): Promise<InterpreterInfo | null>
  listPackages(python: string): Promise<{ packages: { name: string; version: string }[]; error?: string }>
  pipFreeze(python: string): Promise<{ text: string; error?: string }>
  /** requirements.txt / pyproject.toml dependencies, and which aren't installed. */
  /** Which of Ruff and Black can run for this interpreter. */
  toolsAvailable(python: string | null, cwd: string): Promise<{ ruff: boolean; black: boolean }>
  /** Forget which tools were found (after installing one). */
  forgetTools(): Promise<void>
  /** ruff check on a file's text; output is Ruff's JSON. */
  ruffCheck(python: string | null, cwd: string, path: string, text: string): Promise<ToolResult>
  /** ruff check --fix (optionally only some rules); output is the fixed text. */
  ruffFix(python: string | null, cwd: string, path: string, text: string, select?: string[]): Promise<ToolResult>
  /** Format with Ruff or Black (optionally only lines from..to, 1-based); output is the formatted text. */
  formatText(python: string | null, cwd: string, path: string, text: string, tool: 'ruff' | 'black', lines?: { from: number; to: number }): Promise<ToolResult>
  /** Test files in the project and the tests in each. */
  discoverTests(root: string): Promise<TestFile[]>
  hasPytest(python: string): Promise<boolean>
  runTests(req: TestRunRequest): Promise<TestRunResult>
  stopTests(): Promise<void>
  onTestOutput(listener: (text: string) => void): () => void
  checkDependencies(root: string, python: string): Promise<{ sources: string[]; required: { name: string; spec: string }[]; missing: { name: string; spec: string }[]; error?: string }>
}
