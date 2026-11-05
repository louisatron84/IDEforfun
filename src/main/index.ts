import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sortAndFilterEntries } from './dirEntries'
import { listFiles } from './listFiles'
import { createEntry, renameEntry } from './fileOps'
import { searchProject } from './search'
import { gitStatus } from './git'
import { LanguageServer, resolvePythonForAnalysis } from './languageServer'
import type { FindOptions } from '../shared/regex'
import { PythonRunner } from './python'
import { Terminals } from './terminals'
import { DebugAdapter, hasDebugpy, installDebugpy, resolvePython } from './debugAdapter'
import { normalizeSettings } from '../shared/settings'

// Lets automated tests use a throwaway profile instead of the real settings.
if (process.env['IDEFORFUN_USER_DATA']) app.setPath('userData', process.env['IDEFORFUN_USER_DATA'])

const runner = new PythonRunner()
const terminals = new Terminals()
const languageServer = new LanguageServer()
const debugAdapter = new DebugAdapter()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1e1f22',
    title: 'IDEforfun',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // A reload or closed window abandons its terminals: don't leave shells running.
  win.webContents.on('did-start-loading', () => {
    terminals.killAll()
    languageServer.stop()
    debugAdapter.stop()
  })
  win.on('closed', () => {
    terminals.killAll()
    languageServer.stop()
    debugAdapter.stop()
  })

  // The renderer blocks closing (beforeunload) when there are unsaved changes;
  // ask the user here whether to close anyway.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close anyway and lose them?'
    })
    if (choice === 0) event.preventDefault() // preventDefault here = ignore the block and close
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('dialog:openFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = { properties: ['openDirectory' as const] }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('fs:readDir', async (_event, dir: string) => {
  const dirents = await readdir(dir, { withFileTypes: true })
  return sortAndFilterEntries(
    dir,
    dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
  )
})

ipcMain.handle('fs:create', (_event, dir: string, name: string, isDirectory: boolean) => createEntry(dir, name, isDirectory))
ipcMain.handle('fs:rename', (_event, path: string, newName: string) => renameEntry(path, newName))
// To the Recycle Bin (not a permanent delete), so mistakes can be undone.
ipcMain.handle('fs:trash', (_event, path: string) => shell.trashItem(path))
ipcMain.handle('fs:listFiles', (_event, root: string) => listFiles(root))
ipcMain.handle('lsp:start', (event) => {
  languageServer.start(event.sender)
})
ipcMain.on('lsp:send', (_event, message: unknown) => languageServer.send(message))
ipcMain.handle('lsp:resolvePython', (_event, root: string, configured?: string) =>
  resolvePythonForAnalysis(root, configured)
)
ipcMain.handle('git:status', (_event, folder: string) => gitStatus(folder))
ipcMain.handle('search:project', (_event, root: string, query: string, opts: FindOptions) =>
  searchProject(root, query, opts)
)

ipcMain.handle('fs:readFile', async (_event, path: string) => readFile(path, 'utf8'))

ipcMain.handle('fs:writeFile', async (_event, path: string, text: string) => {
  await writeFile(path, text, 'utf8')
})

ipcMain.handle('run:start', (event, file: string, cwd: string, python?: string) =>
  runner.run(event.sender, file, cwd, python)
)
ipcMain.handle('run:stop', () => runner.stop())
ipcMain.handle('run:input', (_event, text: string) => runner.sendInput(text))

ipcMain.handle('debug:prepare', async (_event, cwd: string, configured?: string) => {
  const python = await resolvePython(cwd, configured)
  return { python, hasDebugpy: python ? await hasDebugpy(python) : false }
})
ipcMain.handle('debug:install', (_event, python: string) => installDebugpy(python))
ipcMain.handle('debug:start', (event, python: string, cwd: string) => debugAdapter.start(event.sender, python, cwd))
ipcMain.on('debug:send', (_event, message: unknown) => debugAdapter.send(message))
ipcMain.handle('debug:stop', () => debugAdapter.stop())

ipcMain.handle('term:create', (event, cwd: string | null, cols: number, rows: number) =>
  terminals.create(event.sender, cwd, cols, rows)
)
ipcMain.on('term:write', (_event, id: number, data: string) => terminals.write(id, data))
ipcMain.on('term:resize', (_event, id: number, cols: number, rows: number) => terminals.resize(id, cols, rows))
ipcMain.on('term:kill', (_event, id: number) => terminals.kill(id))

// ---------- settings (userData/settings.json) ----------
const settingsFile = () => join(app.getPath('userData'), 'settings.json')

ipcMain.handle('settings:get', async () => {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsFile(), 'utf8')))
  } catch {
    return normalizeSettings(undefined) // first run, or unreadable file: defaults
  }
})

ipcMain.handle('settings:save', async (_event, settings: unknown) => {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(normalizeSettings(settings), null, 2), 'utf8')
})

app.on('before-quit', () => {
  runner.stop()
  debugAdapter.stop()
  terminals.killAll()
  languageServer.stop()
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
