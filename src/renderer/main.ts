import { FileTree } from './fileTree'
import { TextView } from './editor/textView'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const folderName = $('folder-name')
const fileTitle = $('file-title')
const view = new TextView($('editor'))

const tree = new FileTree($('sidebar'), async (entry) => {
  fileTitle.textContent = entry.path
  try {
    view.setText(await window.api.readFile(entry.path))
  } catch (err) {
    view.showPlaceholder(`Can't open file: ${String(err)}`)
  }
})

$('open-folder').addEventListener('click', async () => {
  const folder = await window.api.openFolder()
  if (!folder) return
  folderName.textContent = folder
  folderName.classList.remove('muted')
  document.title = `${folder.split(/[\\/]/).pop()} — IDEforfun`
  fileTitle.textContent = ''
  view.showPlaceholder('Pick a file from the tree')
  await tree.setRoot(folder)
})
