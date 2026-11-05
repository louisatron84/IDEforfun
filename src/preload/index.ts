import { contextBridge, ipcRenderer } from 'electron'
import type { IdeApi } from '../shared/api'

const api: IdeApi = {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path)
}

contextBridge.exposeInMainWorld('api', api)
