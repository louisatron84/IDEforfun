import type { Settings } from './settings'
import type { FindOptions } from './regex'

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
  error?: string
}

export type GitState = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflict'

/** Changed files (absolute paths) and the folders that contain them. */
export interface GitStatusMap {
  files: Record<string, GitState>
  folders: string[]
}

/** The only bridge between the UI (renderer) and the OS (main process). */
export interface IdeApi {
  openFolder(): Promise<string | null>
  readDir(path: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  /** Create an empty file or folder in `dir` ("pkg/mod.py" makes "pkg" too). Returns its path. */
  createEntry(dir: string, name: string, isDirectory: boolean): Promise<string>
  /** Rename in place; returns the new path. */
  renameEntry(path: string, newName: string): Promise<string>
  /** Move a file or folder to the Recycle Bin. */
  trashEntry(path: string): Promise<void>

  /** Run a Python file (stops any program already running). */
  runPython(file: string, cwd: string, python?: string): Promise<void>
  stopRun(): Promise<void>
  /** Send text to the running program's stdin (for input()). */
  sendRunInput(text: string): Promise<void>
  /** Listen for output/exit events; returns a function that stops listening. */
  onRunEvent(listener: (event: RunEvent) => void): () => void

  /** Start a shell in a pseudo-terminal; returns its id. */
  terminalCreate(cwd: string | null, cols: number, rows: number): Promise<number>
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
}
