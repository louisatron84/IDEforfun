import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { buildMenu, type EditAction, type MenuState } from './menu'
import { ensureProjectFile, ensureProjectSettings, readProjectFile, readProjectSettings, updateProjectSettings, UserState } from './userState'
import { checkDependencies, describePython, findInterpreters, freeze, listPackages } from './pyenv'
import { discoverTests, hasPytest, TestRunner } from './tests'
import { forgetTools, formatText, ruffCheck, ruffFix, toolsAvailable } from './pyTools'
import type { TestRunRequest } from '../shared/api'
import type { KeyOverrides } from '../shared/keybindings'
import type { ProjectSettings } from '../shared/settings'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { sortAndFilterEntries } from './dirEntries'
import { listFiles } from './listFiles'
import { createEntry, renameEntry } from './fileOps'
import { readTextFile, writeTextFile } from './textFile'
import { Backups } from './backups'
import type { BackupData, RunSpec } from '../shared/api'
import type { Encoding } from '../shared/encoding'
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
const backups = new Backups(() => join(app.getPath('userData'), 'backups'))
const userState = new UserState(() => app.getPath('userData'))
const testRunner = new TestRunner()

// The menu shows the window's current shortcuts and the recent folders, so it's rebuilt when they change.
const menuState: MenuState = { keys: {}, recent: [] }
const refreshMenu = () => Menu.setApplicationMenu(buildMenu(menuState))

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
    testRunner.stop()
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
    if (choice === 0) {
      // The user chose to lose the changes: drop their crash-recovery copies too.
      backups.clearSync()
      event.preventDefault() // preventDefault here = ignore the block and close
    }
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
  if (result.canceled) return null
  // Some Linux dialogs return nothing when a path is typed and Enter pressed: say so instead of doing nothing.
  const picked = result.filePaths[0]
  if (!picked) return { error: "The folder dialog didn't return a folder. Try selecting it with the mouse, or use Open Folder by Path (Ctrl+Shift+P)." }
  return checkFolder(picked)
})
// Edit menu actions for text boxes (and pasting into the editor): done natively by Chromium.
ipcMain.on('edit:native', (event, action: EditAction) => {
  if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(action)) event.sender[action]()
})
// "Save changes?" with real buttons. Synchronous, because closing a tab asks and answers in one step.
ipcMain.on('dialog:unsaved', (event, name: string, detail?: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    type: 'warning' as const,
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: `Do you want to save the changes you made to ${name}?`,
    detail: detail ?? "Your changes will be lost if you don't save them."
  }
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)
  event.returnValue = (['save', 'discard', 'cancel'] as const)[choice] ?? 'cancel'
})
ipcMain.handle('fs:checkFolder', (_event, path: string) => checkFolder(path))
// New File with no folder open: pick where it goes, create it empty (an existing file is left as it is).
ipcMain.handle('dialog:newFile', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = {
    title: 'New File',
    buttonLabel: 'Create',
    defaultPath: join(app.getPath('documents'), 'untitled.py'),
    filters: [{ name: 'Python', extensions: ['py'] }, { name: 'All files', extensions: ['*'] }]
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  try {
    await writeFile(res.filePath, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { error: `Couldn't create ${res.filePath}:\n${String(err)}` }
  }
  return res.filePath
})
// New Folder with no folder open: where the new project folder should go.
ipcMain.handle('dialog:pickParent', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = { title: 'Where should the new folder go?', buttonLabel: 'Choose', properties: ['openDirectory' as const, 'createDirectory' as const] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  return checkFolder(res.filePaths[0])
})

/** A folder path that exists (symlinks resolved), or why it can't be opened. */
async function checkFolder(path: string): Promise<string | { error: string }> {
  const trimmed = path.trim().replace(/^["']|["']$/g, '')
  if (!trimmed) return { error: 'Type the path of a folder.' }
  const full = resolve(trimmed.replace(/^~(?=$|[\\/])/, app.getPath('home')))
  try {
    const st = await stat(full)
    if (!st.isDirectory()) return { error: `That's a file, not a folder:\n${full}` }
    await readdir(full) // can we read it?
    return await realpath(full)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const why = code === 'ENOENT' ? "doesn't exist" : code === 'EACCES' || code === 'EPERM' ? "can't be read (permission denied)" : `can't be opened (${code ?? String(err)})`
    return { error: `The folder ${why}:\n${full}` }
  }
}

ipcMain.handle('fs:readDir', async (_event, dir: string) => {
  const dirents = await readdir(dir, { withFileTypes: true })
  const raw = await Promise.all(dirents.map(async (d) => {
    // A symlink shows as what it points to; a broken one shows as a file (opening it explains).
    let isDirectory = d.isDirectory()
    if (d.isSymbolicLink()) {
      try {
        isDirectory = (await stat(join(dir, d.name))).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    return { name: d.name, isDirectory }
  }))
  return sortAndFilterEntries(dir, raw)
})

ipcMain.handle('fs:readText', (_event, path: string, opts?: { force?: boolean; encoding?: Encoding }) => readTextFile(path, opts))
ipcMain.handle('fs:writeText', (_event, path: string, text: string, encoding: Encoding) => writeTextFile(path, text, encoding))
ipcMain.handle('backup:write', (_event, data: BackupData) => backups.write(data))
ipcMain.handle('backup:remove', (_event, path: string) => backups.remove(path))
ipcMain.handle('backup:list', () => backups.list())
ipcMain.handle('fs:create', (_event, dir: string, name: string, isDirectory: boolean) => createEntry(dir, name, isDirectory))
ipcMain.handle('fs:rename', (_event, path: string, newName: string) => renameEntry(path, newName))
// To the Recycle Bin (not a permanent delete), so mistakes can be undone.
ipcMain.handle('fs:trash', (_event, path: string) => shell.trashItem(path))
ipcMain.handle('fs:delete', (_event, path: string) => rm(path, { recursive: true }))
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

ipcMain.handle('run:start', (event, spec: RunSpec) => runner.run(event.sender, spec))
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

ipcMain.handle('term:create', (event, cwd: string | null, cols: number, rows: number, profileId?: string) =>
  terminals.create(event.sender, cwd, cols, rows, profileId)
)
ipcMain.handle('term:shells', () => terminals.shells())
ipcMain.on('term:write', (_event, id: number, data: string) => terminals.write(id, data))
ipcMain.on('term:resize', (_event, id: number, cols: number, rows: number) => terminals.resize(id, cols, rows))
ipcMain.on('term:kill', (_event, id: number) => terminals.kill(id))

// ---------- shortcuts, recent folders, per-project layout and settings ----------
ipcMain.handle('keys:get', () => userState.keybindings())
ipcMain.handle('keys:save', (_event, overrides: KeyOverrides) => userState.saveKeybindings(overrides))
ipcMain.handle('keys:ensureFile', () => userState.ensureKeybindingsFile())
ipcMain.on('menu:setKeys', (_event, keys: Record<string, string | null>) => {
  if (!keys || typeof keys !== 'object') return
  menuState.keys = keys
  refreshMenu()
})
const updateRecent = (list: string[]) => {
  menuState.recent = list
  refreshMenu()
  return list
}
ipcMain.handle('recent:list', () => userState.recent())
ipcMain.handle('recent:add', async (_event, folder: string) => updateRecent(await userState.addRecent(folder)))
ipcMain.handle('recent:remove', async (_event, folder: string) => updateRecent(await userState.removeRecent(folder)))
ipcMain.handle('recent:clear', async () => {
  await userState.clearRecent()
  return updateRecent([])
})
ipcMain.handle('state:get', (_event, root: string) => userState.workspace(root))
// A plain message (not invoke) handled synchronously, so it's saved even while the window closes.
ipcMain.on('state:save', (_event, root: string, state: unknown) => {
  try {
    if (typeof root === 'string' && root) userState.saveWorkspaceSync(root, state)
  } catch (err) {
    console.error('Could not save the workspace layout:', err)
  }
})
ipcMain.handle('project:settings', (_event, root: string) => readProjectSettings(root))
ipcMain.handle('project:ensureSettings', (_event, root: string, initial: ProjectSettings) => ensureProjectSettings(root, initial))
ipcMain.handle('project:updateSettings', (_event, root: string, patch: Record<string, unknown>) => updateProjectSettings(root, patch))
ipcMain.handle('py:interpreters', (_event, root: string | null) => findInterpreters(root))
ipcMain.handle('py:current', async (_event, root: string, configured?: string) => {
  const python = await resolvePython(root, configured)
  return python ? describePython(python) : null
})
ipcMain.handle('py:packages', (_event, python: string) => listPackages(python))
ipcMain.handle('py:freeze', (_event, python: string) => freeze(python))
ipcMain.handle('py:deps', (_event, root: string, python: string) => checkDependencies(root, python))
ipcMain.handle('tools:available', (_event, python: string | null, cwd: string) => toolsAvailable(python, cwd))
ipcMain.handle('tools:forget', () => forgetTools())
ipcMain.handle('tools:ruffCheck', (_event, python: string | null, cwd: string, path: string, text: string) => ruffCheck(python, cwd, path, text))
ipcMain.handle('tools:ruffFix', (_event, python: string | null, cwd: string, path: string, text: string, select?: string[]) =>
  ruffFix(python, cwd, path, text, Array.isArray(select) ? select.filter((s) => /^[A-Z]+\d*$/.test(s)) : undefined)
)
ipcMain.handle('tools:format', (_event, python: string | null, cwd: string, path: string, text: string, tool: 'ruff' | 'black', lines?: { from: number; to: number }) =>
  formatText(python, cwd, path, text, tool === 'black' ? 'black' : 'ruff',
    lines && Number.isInteger(lines.from) && Number.isInteger(lines.to) ? { from: lines.from, to: lines.to } : undefined)
)
ipcMain.handle('tests:discover', (_event, root: string) => discoverTests(root))
ipcMain.handle('tests:hasPytest', (_event, python: string) => hasPytest(python))
ipcMain.handle('tests:run', (event, req: TestRunRequest) => testRunner.run(event.sender, req))
ipcMain.handle('tests:stop', () => testRunner.stop())
ipcMain.handle('project:readFile', (_event, root: string, name: string) => readProjectFile(root, name))
ipcMain.handle('project:ensureFile', (_event, root: string, name: string, initial: unknown) => ensureProjectFile(root, name, initial))

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
  testRunner.stop()
  runner.stop()
  debugAdapter.stop()
  terminals.killAll()
  languageServer.stop()
})

app.whenReady().then(() => {
  menuState.recent = userState.recentSync()
  refreshMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
