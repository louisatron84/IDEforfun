import type { Settings } from './settings'

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

/** The only bridge between the UI (renderer) and the OS (main process). */
export interface IdeApi {
  openFolder(): Promise<string | null>
  readDir(path: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>

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

  /** Every file under a folder (for quick open), skipping .git, node_modules, etc. */
  listFiles(root: string): Promise<{ path: string; rel: string }[]>

  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
}
