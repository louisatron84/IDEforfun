import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sortAndFilterEntries } from './dirEntries'

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

ipcMain.handle('fs:readFile', async (_event, path: string) => readFile(path, 'utf8'))

ipcMain.handle('fs:writeFile', async (_event, path: string, text: string) => {
  await writeFile(path, text, 'utf8')
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
