import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IdeApi, RunEvent, TerminalEvent } from '../shared/api'

const api: IdeApi = {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
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
  debugSend: (message) => ipcRenderer.send('debug:send', message),
  debugStop: () => ipcRenderer.invoke('debug:stop'),
  onDebugMessage: (listener) => {
    const handler = (_e: unknown, message: unknown) => listener(message)
    ipcRenderer.on('debug:message', handler)
    return () => ipcRenderer.removeListener('debug:message', handler)
  },
  onDebugExit: (listener) => {
    const handler = (_e: unknown, info: { code: number | null; error?: string }) => listener(info)
    ipcRenderer.on('debug:exit', handler)
    return () => ipcRenderer.removeListener('debug:exit', handler)
  },
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
  searchProject: (root, query, opts) => ipcRenderer.invoke('search:project', root, query, opts),
  gitStatus: (folder) => ipcRenderer.invoke('git:status', folder),
  lspStart: () => ipcRenderer.invoke('lsp:start'),
  lspSend: (message) => ipcRenderer.send('lsp:send', message),
  onLspMessage: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, message: unknown) => listener(message)
    ipcRenderer.on('lsp:message', handler)
    return () => ipcRenderer.removeListener('lsp:message', handler)
  },
  onLspExit: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, code: number | null) => listener(code)
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
  ensureProjectFile: (root, name, initial) => ipcRenderer.invoke('project:ensureFile', root, name, initial)
}

contextBridge.exposeInMainWorld('api', api)
