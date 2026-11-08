import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { buildMenu, type EditAction, type MenuState } from './menu'
import { ensureProjectFile, ensureProjectSettings, readProjectFile, readProjectSettings, updateProjectSettings, UserState, writeProjectFile } from './userState'
import { testCall } from './apiCall'
import { loadSpec } from './openapiLoad'
import { Updates } from './updates'
import { dataflow } from './dataflow'
import { addEnvToGitignore, envNames, gitignoreHasEnv, setDotEnvValue } from './dotenvFile'
import { normalizeBoxes } from '../shared/boxes'
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
import * as gitOps from './gitOps'
import { LanguageServers, resolvePythonForAnalysis } from './languageServer'
import { scanProject, scanProjectFiles } from './projectScan'
import { prepareProjectDir } from './projectDir'
import type { FindOptions } from '../shared/regex'
import { PythonRunner } from './python'
import { Terminals } from './terminals'
import { createProject, listUserTemplates, saveTemplate } from './projectTemplates'
import { BUILTIN_TEMPLATES, renderTemplate } from '../shared/templates'
import { DebugAdapter, hasDebugpy, installDebugpy, isVirtualEnv, resolvePython } from './debugAdapter'
import { normalizeSettings } from '../shared/settings'

// Lets automated tests use a throwaway profile instead of the real settings.
if (process.env['IDEFORFUN_USER_DATA']) app.setPath('userData', process.env['IDEFORFUN_USER_DATA'])

const runner = new PythonRunner()
const terminals = new Terminals()
const languageServers = new LanguageServers()
const debugAdapter = new DebugAdapter()
const backups = new Backups(() => join(app.getPath('userData'), 'backups'))
const userState = new UserState(() => app.getPath('userData'))
const testRunner = new TestRunner()
/** New versions on GitHub Releases: checking, downloading, installing (the window shows where it stands). */
const updates = new Updates((state) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', state)
})

// The menu shows the window's current shortcuts and the recent folders, so it's rebuilt when they change.
const menuState: MenuState = { keys: {}, recent: [] }
const refreshMenu = () => Menu.setApplicationMenu(buildMenu(menuState))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1e1f22',
    title: 'Forge',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Only Forge's own floating panels open windows (blank, filled by the window itself);
  // web links go to the browser; anything else is refused.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && /^forge-float-[\w-]{1,40}$/.test(frameName)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 640, height: 460, title: 'Forge', backgroundColor: '#1e1f22', autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        }
      }
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-create-window', (child) => child.setMenu(null))
  // Floating windows close with the main one.
  win.on('closed', () => {
    for (const w of BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed()) w.destroy()
  })

  // A reload or closed window abandons its terminals: don't leave shells running.
  win.webContents.on('did-start-loading', () => {
    testRunner.stop()
    terminals.killAll()
    languageServers.stop()
    debugAdapter.stop()
  })
  win.on('closed', () => {
    terminals.killAll()
    languageServers.stop()
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

// ----- project templates (Forge's, and yours in <userData>/templates) -----
const templatesDir = () => join(app.getPath('userData'), 'templates')
const allTemplates = async () => [...BUILTIN_TEMPLATES, ...(await listUserTemplates(templatesDir()))]
ipcMain.handle('templates:list', async () => (await allTemplates()).map(({ id, name, detail, user }) => ({ id, name, detail, ...(user ? { user } : {}) })))
ipcMain.handle('templates:create', async (_event, parent: unknown, name: unknown, templateId: unknown) => {
  if (typeof parent !== 'string' || typeof name !== 'string' || typeof templateId !== 'string') throw new Error('Bad request')
  const t = (await allTemplates()).find((x) => x.id === templateId)
  if (!t) throw new Error('That template no longer exists.')
  const files = renderTemplate(t, name)
  const path = await createProject(parent, name, files)
  const open = t.open ? renderTemplate({ ...t, files: [{ path: t.open, content: '' }] }, name)[0].path : undefined
  return { path, open, packages: files.some((f) => f.path === 'requirements.txt' || f.path === 'pyproject.toml') }
})
ipcMain.handle('templates:save', async (_event, root: unknown, name: unknown) => {
  if (typeof root !== 'string' || typeof name !== 'string') throw new Error('Bad request')
  await saveTemplate(root, templatesDir(), name)
  return name.trim()
})
ipcMain.handle('fs:rename', (_event, path: string, newName: string) => renameEntry(path, newName))
// To the Recycle Bin (not a permanent delete), so mistakes can be undone.
ipcMain.handle('fs:trash', (_event, path: string) => shell.trashItem(path))
ipcMain.handle('fs:delete', (_event, path: string) => rm(path, { recursive: true }))
ipcMain.handle('fs:listFiles', (_event, root: string) => listFiles(root))
ipcMain.handle('project:prepare', (_event, root: string) => prepareProjectDir(root))
ipcMain.handle('graph:scan', (_event, root: string, python?: string, overrides?: Record<string, string>) => scanProject(root, python, cleanOverrides(overrides)))
ipcMain.handle('graph:scanFiles', (_event, root: string, rels: string[], python?: string, overrides?: Record<string, string>) =>
  scanProjectFiles(root, (Array.isArray(rels) ? rels : []).filter((r) => typeof r === 'string' && /\.pyi?$/i.test(r) && !r.split(/[\\/]/).includes('..')), python, cleanOverrides(overrides)))

/** Editor text for the analysis: plain strings, Python files inside the project only. */
function cleanOverrides(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && /\.pyi?$/i.test(k) && !k.split(/[\\/]/).includes('..')) out[k.replace(/\\/g, '/')] = v
  }
  return out
}
ipcMain.handle('lsp:start', (event, id: string) => {
  languageServers.start(id, event.sender)
})
ipcMain.handle('lsp:stop', (_event, id: string) => languageServers.stop(id))
ipcMain.on('lsp:send', (_event, id: string, message: unknown) => languageServers.send(id, message))
ipcMain.handle('lsp:resolvePython', (_event, root: string, configured?: string) =>
  resolvePythonForAnalysis(root, configured)
)
ipcMain.handle('git:status', (_event, folder: string) => gitStatus(folder))
const paths = (p: unknown): string[] => (Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string' && x.length > 0) : [])
ipcMain.handle('git:repo', (_event, folder: string) => gitOps.repoStatus(folder))
ipcMain.handle('git:diff', (_event, root: string, path: string, staged: boolean) => gitOps.fileDiff(root, path, !!staged))
ipcMain.handle('git:stage', (_event, root: string, p: unknown) => gitOps.stage(root, paths(p)))
ipcMain.handle('git:unstage', (_event, root: string, p: unknown) => gitOps.unstage(root, paths(p)))
ipcMain.handle('git:discard', (_event, root: string, p: unknown) => gitOps.discard(root, paths(p)))
ipcMain.handle('git:apply', (_event, root: string, patchText: string, opts: { cached: boolean; reverse: boolean }) =>
  gitOps.applyPatch(root, String(patchText), { cached: !!opts?.cached, reverse: !!opts?.reverse })
)
ipcMain.handle('git:commit', (_event, root: string, message: string, opts: { amend: boolean; all: boolean }) =>
  gitOps.commit(root, String(message), { amend: !!opts?.amend, all: !!opts?.all })
)
ipcMain.handle('git:lastMessage', (_event, root: string) => gitOps.lastCommitMessage(root))
ipcMain.handle('git:branches', (_event, root: string) => gitOps.branches(root))
ipcMain.handle('git:switch', (_event, root: string, name: string, opts: { create: boolean; remote: boolean }) =>
  gitOps.switchBranch(root, String(name), { create: !!opts?.create, remote: !!opts?.remote })
)
ipcMain.handle('git:sync', (_event, root: string, action: string) =>
  action === 'fetch' || action === 'pull' || action === 'push' ? gitOps.sync(root, action) : { ok: false, output: '', error: 'unknown action' }
)
ipcMain.handle('git:init', (_event, folder: string) => gitOps.init(folder))
ipcMain.handle('git:log', (_event, root: string, opts: { all?: boolean; path?: string; limit?: number; skip?: number }) =>
  gitOps.log(root, { all: !!opts?.all, path: typeof opts?.path === 'string' && opts.path ? opts.path : undefined, limit: Number(opts?.limit) || 200, skip: Number(opts?.skip) || 0 })
)
ipcMain.handle('git:commitDetails', (_event, root: string, sha: string) => gitOps.commitDetails(root, String(sha)))
ipcMain.handle('git:commitFileDiff', (_event, root: string, sha: string, path: string) => gitOps.commitFileDiff(root, String(sha), String(path)))
ipcMain.handle('git:blame', (_event, root: string, path: string, contents?: string) =>
  gitOps.blame(root, String(path), typeof contents === 'string' ? contents : undefined)
)
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
  if (!python) return { python, hasDebugpy: false, isVenv: false }
  const [has, venv] = await Promise.all([hasDebugpy(python), isVirtualEnv(python)])
  return { python, hasDebugpy: has, isVenv: venv }
})
ipcMain.handle('debug:install', (_event, python: string) => installDebugpy(python))
ipcMain.handle('debug:start', (event, python: string, cwd: string) => debugAdapter.start(event.sender, python, cwd))
ipcMain.on('debug:send', (_event, id: number, message: unknown) => debugAdapter.send(id, message))
ipcMain.handle('debug:connect', (_event, host: string, port: number) => debugAdapter.connect(host, port))
ipcMain.handle('debug:stop', () => debugAdapter.stop())

ipcMain.handle('term:create', (event, cwd: string | null, cols: number, rows: number, profileId?: string) =>
  terminals.create(event.sender, cwd, cols, rows, profileId)
)
ipcMain.handle('term:run', (event, args: unknown, cwd: string | null, env: unknown, cols: number, rows: number) => {
  const list = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
  const vars: Record<string, string | null> = {}
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) if (typeof v === 'string' || v === null) vars[k] = v
  }
  return terminals.run(event.sender, list, cwd, vars, cols, rows)
})
ipcMain.handle('term:shells', () => terminals.shells())
ipcMain.on('term:write', (_event, id: number, data: string) => terminals.write(id, data))
ipcMain.on('term:resize', (_event, id: number, cols: number, rows: number) => terminals.resize(id, cols, rows))
ipcMain.on('term:kill', (_event, id: number) => terminals.kill(id))

// ---------- shortcuts, recent folders, per-project layout and settings ----------
ipcMain.handle('keys:get', () => userState.keybindings())
ipcMain.handle('layouts:get', () => userState.layouts())
ipcMain.handle('layouts:save', (_event, layouts: unknown) => userState.saveLayouts(layouts))
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
ipcMain.handle('project:writeFile', (_event, root: string, name: string, value: unknown) => writeProjectFile(String(root), String(name), value))

// ---------- Connect: the API box ----------
ipcMain.handle('box:testCall', (_event, root: string, box: unknown, requestId: string) => {
  // Re-checked here: only what a box can hold is used.
  const [checked] = normalizeBoxes({ boxes: [box] })
  if (!checked) return { ok: false, ms: 0, error: 'Not an API box.' }
  return testCall(String(root), checked, String(requestId))
})
ipcMain.handle('env:names', (_event, root: string) => envNames(String(root)))
ipcMain.handle('openapi:load', (_event, source: string) => loadSpec(String(source)))
ipcMain.handle('update:check', (_event, manual: boolean, auto?: boolean) => updates.check(manual === true, auto === true))
ipcMain.handle('update:whatsNew', () => updates.whatsNew())
ipcMain.handle('update:notes', (_event, version: unknown) => (typeof version === 'string' && /^[\w.-]{1,40}$/.test(version) ? updates.notesFor(version) : ''))
ipcMain.handle('update:download', () => updates.download())
ipcMain.handle('update:install', () => updates.install())
ipcMain.handle('update:current', () => updates.current)
ipcMain.handle('dataflow:read', (_event, root: string, source: string, func: string, python?: string) =>
  dataflow(String(root), String(source), String(func ?? ''), typeof python === 'string' && python ? python : undefined))
ipcMain.handle('openapi:pick', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = { title: 'Choose an OpenAPI description', buttonLabel: 'Open', properties: ['openFile' as const], filters: [{ name: 'OpenAPI (JSON or YAML)', extensions: ['json', 'yaml', 'yml'] }, { name: 'All files', extensions: ['*'] }] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
})
ipcMain.handle('env:set', (_event, root: string, name: string, value: string) => setDotEnvValue(String(root), String(name), String(value)))
ipcMain.handle('env:ignored', (_event, root: string) => gitignoreHasEnv(String(root)))
ipcMain.handle('env:ignore', (_event, root: string) => addEnvToGitignore(String(root)))

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
  languageServers.stop()
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
