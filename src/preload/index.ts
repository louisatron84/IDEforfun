import { contextBridge, ipcRenderer } from 'electron'
import type { IdeApi, RunEvent } from '../shared/api'

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
  }
}

contextBridge.exposeInMainWorld('api', api)
