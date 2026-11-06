import type { RawScan } from './projectGraph'
import type { ApiBox } from './boxes'
import type { ProjectSettings, Settings } from './settings'
import type { KeyOverrides } from './keybindings'
import type { SavedLayouts } from './layouts'
import type { WorkspaceState } from './projectState'
import type { TestFile } from './tests'
import type { Branch, RepoStatus } from './git'
import type { BlameLine, Commit } from './history'
import type { FindOptions } from './regex'
import type { Encoding, TextFileResult } from './encoding'

/** What the API box's test call got back. */
export interface TestCallResult {
  ok: boolean
  status?: number
  statusText?: string
  ms: number
  /** The response, when it was JSON. */
  json?: unknown
  /** Otherwise the start of its text. */
  text?: string
  /** Over the size limit (5 MB). */
  tooBig?: boolean
  error?: string
}

/** What a git command gave back: its output, or what went wrong. */
export interface GitResult {
  ok: boolean
  output: string
  error?: string
}

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
  /** Show the run on the Graph: start it through Forge's tracer. */
  trace?: boolean
  /** Also record what each line of this function (`module:qual`) produces (implies trace). */
  traceData?: string
}

/** One message from a traced run's tracer (checked by the window before use). */
export interface RunTraceEvent {
  runId: number
  message: unknown
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
  /** Where a traced run is at (see RunSpec.trace). */
  onRunTrace(listener: (event: RunTraceEvent) => void): () => void

  /** Start a shell in a pseudo-terminal; returns its id. */
  terminalCreate(cwd: string | null, cols: number, rows: number, profileId?: string): Promise<number>
  /** Run a program (not a shell) in a terminal, e.g. the program being debugged. */
  terminalRun(args: string[], cwd: string | null, env: Record<string, string | null>, cols: number, rows: number): Promise<{ id: number; pid: number }>
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
  /** Send to a debugger connection: 0 is the program, others are its child processes (see debugConnect). */
  debugSend(connection: number, message: unknown): void
  /** Attach to a child process: open another connection to the adapter (a local port it gave). */
  debugConnect(host: string, port: number): Promise<number>
  debugStop(): Promise<void>
  onDebugMessage(listener: (connection: number, message: unknown) => void): () => void
  /** Connection 0 closed: the adapter exited. Others: that child's connection closed. */
  onDebugExit(listener: (connection: number, info: { code: number | null; error?: string }) => void): () => void

  /** Every file under a folder (for quick open), skipping .git, node_modules, etc. */
  listFiles(root: string): Promise<{ path: string; rel: string }[]>
  /**
   * Get <project>/.forge ready: a legacy .ideforfun folder is renamed ('migrated'),
   * or copied when it can't be ('copied'); 'both' = both exist (.forge is used);
   * 'error' = neither worked (nothing changed).
   */
  prepareProjectDir(root: string): Promise<'none' | 'migrated' | 'copied' | 'both' | 'error'>
  /** Analyse every Python file of a project (for the Project Graph); `python`: the configured interpreter. */
  scanProject(root: string, python?: string): Promise<{ scan?: RawScan; error?: string }>

  /** Search every text file under `root` (Ctrl+Shift+F). */
  searchProject(root: string, query: string, opts: FindOptions): Promise<ProjectSearchResult>

  /** Git status of files under a folder; null if it isn't a git repository. */
  gitStatus(folder: string): Promise<GitStatusMap | null>
  /** The repository containing a folder: its root, branch and changes (null if none). */
  gitRepo(folder: string): Promise<(RepoStatus & { root: string }) | null>
  /** Unified diff of one file (repo-relative path), staged or not. */
  gitDiff(root: string, path: string, staged: boolean): Promise<GitResult>
  gitStage(root: string, paths: string[]): Promise<GitResult>
  gitUnstage(root: string, paths: string[]): Promise<GitResult>
  /** Throw away unstaged changes to tracked files. */
  gitDiscard(root: string, paths: string[]): Promise<GitResult>
  /** Apply a one-hunk patch to the index (stage / unstage) or the working tree (discard). */
  gitApply(root: string, patch: string, opts: { cached: boolean; reverse: boolean }): Promise<GitResult>
  gitCommit(root: string, message: string, opts: { amend: boolean; all: boolean }): Promise<GitResult>
  gitLastMessage(root: string): Promise<string>
  gitBranches(root: string): Promise<Branch[]>
  gitSwitch(root: string, name: string, opts: { create: boolean; remote: boolean }): Promise<GitResult>
  gitSync(root: string, action: 'fetch' | 'pull' | 'push'): Promise<GitResult>
  gitInit(folder: string): Promise<GitResult>
  /** Commits newest first (all branches, or one file's history). */
  gitLog(root: string, opts: { all: boolean; path?: string; limit: number; skip: number }): Promise<{ ok: boolean; commits: Commit[]; error?: string }>
  /** A commit's message and changed files. */
  gitCommitDetails(root: string, sha: string): Promise<{ ok: boolean; message: string; files: { path: string; from?: string; status: string }[]; error?: string }>
  /** What a commit changed in one file. */
  gitCommitFileDiff(root: string, sha: string, path: string): Promise<GitResult>
  /** Who last changed each line (`contents`: the editor's text, so unsaved edits line up). */
  gitBlame(root: string, path: string, contents?: string): Promise<{ ok: boolean; lines: BlameLine[]; error?: string }>

  /** Start (or restart) a language server by its id (e.g. 'pyright'). */
  lspStart(server: string): Promise<void>
  lspStop(server: string): Promise<void>
  /** Send a JSON-RPC message to a language server. */
  lspSend(server: string, message: unknown): void
  onLspMessage(listener: (server: string, message: unknown) => void): () => void
  onLspExit(listener: (server: string, code: number | null) => void): () => void
  /** The interpreter Pyright should analyse with (configured, or the project's venv). */
  resolvePythonForAnalysis(root: string, configured?: string): Promise<string | undefined>

  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>

  /** Your workspace arrangement per task (layouts.json; missing tasks use their defaults). */
  getLayouts(): Promise<SavedLayouts>
  saveLayouts(layouts: SavedLayouts): Promise<void>
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
  /** <project>/.forge/settings.json */
  projectSettings(root: string): Promise<{ settings: ProjectSettings; path: string; exists: boolean; error?: string }>
  /** Create the project settings file if needed; returns its path. */
  ensureProjectSettings(root: string, initial: ProjectSettings): Promise<string>
  /** Another file in <project>/.forge (e.g. run.json): its JSON, or why it can't be read. */
  readProjectFile(root: string, name: string): Promise<{ value: unknown; path: string; exists: boolean; error?: string }>
  ensureProjectFile(root: string, name: string, initial: unknown): Promise<string>
  /** Replace a file in <project>/.forge (e.g. boxes.json); returns its path. */
  writeProjectFile(root: string, name: string, value: unknown): Promise<string>

  /** Test call: send one of the API box's requests (secrets come from .env, in the main process). */
  apiTestCall(root: string, box: ApiBox, requestId: string): Promise<TestCallResult>
  /** Read a function's data flow (its parameters and steps) from a file's text; with no function, just list them. */
  readDataflow(root: string, source: string, func: string, python?: string): Promise<import('./dataflow').RawFlow>
  /** Load an OpenAPI description from an http(s) address or a file (JSON or YAML). */
  loadOpenApi(source: string): Promise<{ doc?: unknown; from: string; error?: string }>
  /** Pick an OpenAPI file; null if cancelled. */
  pickOpenApiFile(): Promise<string | null>
  /** The project's .env variables that have a value (names only). */
  envNames(root: string): Promise<string[]>
  /** Set one variable in the project's .env. */
  setEnvValue(root: string, name: string, value: string): Promise<void>
  /** Whether .gitignore covers .env. */
  envIgnored(root: string): Promise<boolean>
  addEnvToGitignore(root: string): Promise<void>
  /** Set (or with undefined, remove) values in the project's .forge/settings.json, keeping the rest. */
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
