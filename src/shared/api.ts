export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

/** The only bridge between the UI (renderer) and the OS (main process). */
export interface IdeApi {
  openFolder(): Promise<string | null>
  readDir(path: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
}
