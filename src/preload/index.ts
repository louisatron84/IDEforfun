import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IdeApi, RunEvent, TerminalEvent } from '../shared/api'

const api: IdeApi = {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  newFileDialog: () => ipcRenderer.invoke('dialog:newFile'),
  pickParentFolder: () => ipcRenderer.invoke('dialog:pickParent'),
  checkFolder: (path) => ipcRenderer.invoke('fs:checkFolder', path),
  onMenuCommand: (listener) => {
    const handler = (_e: unknown, id: string) => listener(id)
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  },
  onMenuEdit: (listener) => {
    const handler = (_e: unknown, action: Parameters<typeof listener>[0]) => listener(action)
    ipcRenderer.on('menu:edit', handler)
    return () => ipcRenderer.removeListener('menu:edit', handler)
  },
  nativeEdit: (action) => ipcRenderer.send('edit:native', action),
  askUnsaved: (name, detail) => ipcRenderer.sendSync('dialog:unsaved', name, detail),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, text) => ipcRenderer.invoke('fs:writeFile', path, text),
  readTextFile: (path, opts) => ipcRenderer.invoke('fs:readText', path, opts),
  writeTextFile: (path, text, encoding) => ipcRenderer.invoke('fs:writeText', path, text, encoding),
  backupWrite: (data) => ipcRenderer.invoke('backup:write', data),
  backupRemove: (path) => ipcRenderer.invoke('backup:remove', path),
  backupList: () => ipcRenderer.invoke('backup:list'),
  createEntry: (dir, name, isDirectory) => ipcRenderer.invoke('fs:create', dir, name, isDirectory),
  renameEntry: (path, newName) => ipcRenderer.invoke('fs:rename', path, newName),
  trashEntry: (path) => ipcRenderer.invoke('fs:trash', path),
  deletePermanently: (path) => ipcRenderer.invoke('fs:delete', path),
  runPython: (spec) => ipcRenderer.invoke('run:start', spec),
  stopRun: () => ipcRenderer.invoke('run:stop'),
  sendRunInput: (text) => ipcRenderer.invoke('run:input', text),
  onRunEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: RunEvent) => listener(event)
    ipcRenderer.on('run:event', handler)
    return () => ipcRenderer.removeListener('run:event', handler)
  },
  terminalCreate: (cwd, cols, rows, profileId) => ipcRenderer.invoke('term:create', cwd, cols, rows, profileId),
  terminalRun: (args, cwd, env, cols, rows) => ipcRenderer.invoke('term:run', args, cwd, env, cols, rows),
  terminalShells: () => ipcRenderer.invoke('term:shells'),
  // Keystrokes and resizes are fire-and-forget (send, not invoke) to keep typing snappy.
  terminalWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  terminalKill: (id) => ipcRenderer.send('term:kill', id),
  onTerminalEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: TerminalEvent) => listener(event)
    ipcRenderer.on('term:event', handler)
    return () => ipcRenderer.removeListener('term:event', handler)
  },
  debugPrepare: (cwd, python) => ipcRenderer.invoke('debug:prepare', cwd, python),
  debugInstall: (python) => ipcRenderer.invoke('debug:install', python),
  debugStart: (python, cwd) => ipcRenderer.invoke('debug:start', python, cwd),
  debugSend: (connection, message) => ipcRenderer.send('debug:send', connection, message),
  debugConnect: (host, port) => ipcRenderer.invoke('debug:connect', host, port),
  debugStop: () => ipcRenderer.invoke('debug:stop'),
  onDebugMessage: (listener) => {
    const handler = (_e: unknown, connection: number, message: unknown) => listener(connection, message)
    ipcRenderer.on('debug:message', handler)
    return () => ipcRenderer.removeListener('debug:message', handler)
  },
  onDebugExit: (listener) => {
    const handler = (_e: unknown, connection: number, info: { code: number | null; error?: string }) => listener(connection, info)
    ipcRenderer.on('debug:exit', handler)
    return () => ipcRenderer.removeListener('debug:exit', handler)
  },
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
  searchProject: (root, query, opts) => ipcRenderer.invoke('search:project', root, query, opts),
  gitStatus: (folder) => ipcRenderer.invoke('git:status', folder),
  gitRepo: (folder) => ipcRenderer.invoke('git:repo', folder),
  gitDiff: (root, path, staged) => ipcRenderer.invoke('git:diff', root, path, staged),
  gitStage: (root, paths) => ipcRenderer.invoke('git:stage', root, paths),
  gitUnstage: (root, paths) => ipcRenderer.invoke('git:unstage', root, paths),
  gitDiscard: (root, paths) => ipcRenderer.invoke('git:discard', root, paths),
  gitApply: (root, patch, opts) => ipcRenderer.invoke('git:apply', root, patch, opts),
  gitCommit: (root, message, opts) => ipcRenderer.invoke('git:commit', root, message, opts),
  gitLastMessage: (root) => ipcRenderer.invoke('git:lastMessage', root),
  gitBranches: (root) => ipcRenderer.invoke('git:branches', root),
  gitSwitch: (root, name, opts) => ipcRenderer.invoke('git:switch', root, name, opts),
  gitSync: (root, action) => ipcRenderer.invoke('git:sync', root, action),
  gitInit: (folder) => ipcRenderer.invoke('git:init', folder),
  gitLog: (root, opts) => ipcRenderer.invoke('git:log', root, opts),
  gitCommitDetails: (root, sha) => ipcRenderer.invoke('git:commitDetails', root, sha),
  gitCommitFileDiff: (root, sha, path) => ipcRenderer.invoke('git:commitFileDiff', root, sha, path),
  gitBlame: (root, path, contents) => ipcRenderer.invoke('git:blame', root, path, contents),
  lspStart: (server) => ipcRenderer.invoke('lsp:start', server),
  lspStop: (server) => ipcRenderer.invoke('lsp:stop', server),
  lspSend: (server, message) => ipcRenderer.send('lsp:send', server, message),
  onLspMessage: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, server: string, message: unknown) => listener(server, message)
    ipcRenderer.on('lsp:message', handler)
    return () => ipcRenderer.removeListener('lsp:message', handler)
  },
  onLspExit: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, server: string, code: number | null) => listener(server, code)
    ipcRenderer.on('lsp:exit', handler)
    return () => ipcRenderer.removeListener('lsp:exit', handler)
  },
  resolvePythonForAnalysis: (root, configured) => ipcRenderer.invoke('lsp:resolvePython', root, configured),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getKeybindings: () => ipcRenderer.invoke('keys:get'),
  saveKeybindings: (overrides) => ipcRenderer.invoke('keys:save', overrides),
  ensureKeybindingsFile: () => ipcRenderer.invoke('keys:ensureFile'),
  setMenuKeys: (keys) => ipcRenderer.send('menu:setKeys', keys),
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentAdd: (folder) => ipcRenderer.invoke('recent:add', folder),
  recentRemove: (folder) => ipcRenderer.invoke('recent:remove', folder),
  recentClear: () => ipcRenderer.invoke('recent:clear'),
  onMenuOpenRecent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, folder: string) => listener(folder)
    ipcRenderer.on('menu:openRecent', handler)
    return () => ipcRenderer.removeListener('menu:openRecent', handler)
  },
  workspaceState: (root) => ipcRenderer.invoke('state:get', root),
  saveWorkspaceState: (root, state) => ipcRenderer.send('state:save', root, state),
  projectSettings: (root) => ipcRenderer.invoke('project:settings', root),
  ensureProjectSettings: (root, initial) => ipcRenderer.invoke('project:ensureSettings', root, initial),
  readProjectFile: (root, name) => ipcRenderer.invoke('project:readFile', root, name),
  ensureProjectFile: (root, name, initial) => ipcRenderer.invoke('project:ensureFile', root, name, initial),
  updateProjectSettings: (root, patch) => ipcRenderer.invoke('project:updateSettings', root, patch),
  findInterpreters: (root) => ipcRenderer.invoke('py:interpreters', root),
  currentInterpreter: (root, configured) => ipcRenderer.invoke('py:current', root, configured),
  listPackages: (python) => ipcRenderer.invoke('py:packages', python),
  pipFreeze: (python) => ipcRenderer.invoke('py:freeze', python),
  checkDependencies: (root, python) => ipcRenderer.invoke('py:deps', root, python),
  toolsAvailable: (python, cwd) => ipcRenderer.invoke('tools:available', python, cwd),
  forgetTools: () => ipcRenderer.invoke('tools:forget'),
  ruffCheck: (python, cwd, path, text) => ipcRenderer.invoke('tools:ruffCheck', python, cwd, path, text),
  ruffFix: (python, cwd, path, text, select) => ipcRenderer.invoke('tools:ruffFix', python, cwd, path, text, select),
  formatText: (python, cwd, path, text, tool, lines) => ipcRenderer.invoke('tools:format', python, cwd, path, text, tool, lines),
  discoverTests: (root) => ipcRenderer.invoke('tests:discover', root),
  hasPytest: (python) => ipcRenderer.invoke('tests:hasPytest', python),
  runTests: (req) => ipcRenderer.invoke('tests:run', req),
  stopTests: () => ipcRenderer.invoke('tests:stop'),
  onTestOutput: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, text: string) => listener(text)
    ipcRenderer.on('tests:output', handler)
    return () => ipcRenderer.removeListener('tests:output', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
