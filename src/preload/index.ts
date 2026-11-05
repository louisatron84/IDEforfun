import { contextBridge, ipcRenderer } from 'electron'
import type { IdeApi, RunEvent, TerminalEvent } from '../shared/api'

const api: IdeApi = {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, text) => ipcRenderer.invoke('fs:writeFile', path, text),
  runPython: (file, cwd, python) => ipcRenderer.invoke('run:start', file, cwd, python),
  stopRun: () => ipcRenderer.invoke('run:stop'),
  sendRunInput: (text) => ipcRenderer.invoke('run:input', text),
  onRunEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: RunEvent) => listener(event)
    ipcRenderer.on('run:event', handler)
    return () => ipcRenderer.removeListener('run:event', handler)
  },
  terminalCreate: (cwd, cols, rows) => ipcRenderer.invoke('term:create', cwd, cols, rows),
  // Keystrokes and resizes are fire-and-forget (send, not invoke) to keep typing snappy.
  terminalWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  terminalKill: (id) => ipcRenderer.send('term:kill', id),
  onTerminalEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: TerminalEvent) => listener(event)
    ipcRenderer.on('term:event', handler)
    return () => ipcRenderer.removeListener('term:event', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
