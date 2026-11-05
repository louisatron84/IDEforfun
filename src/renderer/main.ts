import { FileTree } from './fileTree'
import { Editor } from './editor/editor'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const folderName = $('folder-name')
const fileTitle = $('file-title')

let currentFile: string | null = null

const editor = new Editor($('editor'), { onDirtyChange: () => updateTitle() })

function updateTitle(): void {
  fileTitle.textContent = currentFile ? (editor.dirty ? '● ' : '') + currentFile : ''
  fileTitle.classList.toggle('dirty', editor.dirty)
}

/** Ask before throwing away unsaved edits. Returns true if it's OK to continue. */
function confirmDiscard(): boolean {
  if (!editor.dirty || !currentFile) return true
  const name = currentFile.split(/[\\/]/).pop()
  return confirm(`${name} has unsaved changes. Discard them?`)
}

async function save(): Promise<void> {
  if (!currentFile) return
  try {
    await window.api.writeFile(currentFile, editor.getText())
    editor.markSaved()
  } catch (err) {
    alert(`Couldn't save ${currentFile}:\n${String(err)}`)
  }
}

const tree = new FileTree($('sidebar'), async (entry) => {
  if (entry.path === currentFile) {
    editor.focus()
    return true
  }
  if (!confirmDiscard()) return false
  try {
    const text = await window.api.readFile(entry.path)
    currentFile = entry.path
    editor.open(text)
    updateTitle()
    return true
  } catch (err) {
    alert(`Can't open ${entry.path}:\n${String(err)}`)
    return false
  }
})

$('open-folder').addEventListener('click', async () => {
  if (!confirmDiscard()) return
  const folder = await window.api.openFolder()
  if (!folder) return
  folderName.textContent = folder
  folderName.classList.remove('muted')
  document.title = `${folder.split(/[\\/]/).pop()} — IDEforfun`
  currentFile = null
  editor.markSaved()
  updateTitle()
  editor.showPlaceholder('Pick a file from the tree')
  await tree.setRoot(folder)
})

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void save()
  }
})

// Block closing the window with unsaved changes; the main process then asks the user.
window.addEventListener('beforeunload', (e) => {
  if (editor.dirty) {
    e.preventDefault()
    e.returnValue = ''
  }
})
