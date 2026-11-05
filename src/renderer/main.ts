import { FileTree } from './fileTree'
import { Editor } from './editor/editor'
import type { Doc } from './editor/document'
import { Workspace } from './workspace'
import { TabBar } from './tabBar'
import { CommandRegistry } from './keymap'
import { FindBar } from './findBar'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const folderName = $('folder-name')
let rootFolder: string | null = null

const workspace = new Workspace(window.api, (doc: Doc) =>
  confirm(`${doc.name} has unsaved changes. Close it without saving?`)
)
const editor = new Editor($('editor'), { onEdit: () => workspace.notifyChanged() })
const tabBar = new TabBar($('tabs'), workspace)
const tree = new FileTree($('sidebar'), (entry) => void openFile(entry.path))
export const commands = new CommandRegistry()
const findBar = new FindBar($('editor-pane'), editor)

// Keep the editor, tabs, tree highlight and window title in sync with the workspace.
workspace.subscribe(() => {
  tabBar.render()
  const doc = workspace.active
  if (doc !== editor.currentDoc) {
    if (doc) editor.show(doc)
    else editor.showPlaceholder(rootFolder ? 'Pick a file from the tree' : 'Open a folder and pick a file')
  }
  tree.highlight(doc?.path ?? null)
  findBar.refresh()
  const folder = rootFolder?.split(/[\\/]/).pop()
  document.title = [doc ? (doc.dirty ? '● ' : '') + doc.name : null, folder, 'IDEforfun']
    .filter(Boolean).join(' — ')
})

export async function openFile(path: string, line?: number): Promise<Doc | null> {
  try {
    const doc = await workspace.open(path)
    if (line !== undefined) editor.goTo(line)
    return doc
  } catch (err) {
    alert(`Can't open ${path}:\n${String(err)}`)
    return null
  }
}

async function saveActive(): Promise<boolean> {
  const doc = workspace.active
  if (!doc) return false
  try {
    await workspace.save(doc)
    return true
  } catch (err) {
    alert(`Couldn't save ${doc.path}:\n${String(err)}`)
    return false
  }
}

async function openFolder(): Promise<void> {
  if (!workspace.closeAll()) return
  const folder = await window.api.openFolder()
  if (!folder) {
    workspace.notifyChanged()
    return
  }
  rootFolder = folder
  folderName.textContent = folder
  folderName.classList.remove('muted')
  await tree.setRoot(folder)
  workspace.notifyChanged()
}

// ---------- commands ----------

const hasDoc = () => workspace.active !== null

commands.register({ id: 'file.openFolder', title: 'Open Folder…', keys: 'Ctrl+O', run: openFolder })
commands.register({ id: 'file.save', title: 'Save', keys: 'Ctrl+S', when: hasDoc, run: () => void saveActive() })
commands.register({
  id: 'tab.close', title: 'Close Tab', keys: 'Ctrl+W', when: hasDoc,
  run: () => { if (workspace.active) workspace.close(workspace.active) }
})
commands.register({ id: 'tab.next', title: 'Next Tab', keys: 'Ctrl+Tab', when: hasDoc, run: () => workspace.next(1) })
commands.register({ id: 'tab.prev', title: 'Previous Tab', keys: 'Ctrl+Shift+Tab', when: hasDoc, run: () => workspace.next(-1) })

commands.register({ id: 'find.open', title: 'Find', keys: 'Ctrl+F', when: hasDoc, run: () => findBar.open(false) })
commands.register({ id: 'find.replace', title: 'Find and Replace', keys: 'Ctrl+H', when: hasDoc, run: () => findBar.open(true) })
commands.register({ id: 'find.close', title: 'Close Find', keys: 'Escape', when: () => findBar.isOpen, run: () => findBar.close() })

$('open-folder').addEventListener('click', () => void openFolder())

// Global shortcuts. Capture phase, so they win over the editor's own key handling.
window.addEventListener('keydown', (e) => {
  if (commands.handleKey(e)) {
    e.preventDefault()
    e.stopPropagation()
  }
}, { capture: true })

// Block closing the window with unsaved changes; the main process then asks the user.
window.addEventListener('beforeunload', (e) => {
  if (workspace.anyDirty) {
    e.preventDefault()
    e.returnValue = ''
  }
})

export { workspace, editor, saveActive }
export const getRootFolder = () => rootFolder
