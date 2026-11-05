import { FileTree } from './fileTree'
import { Editor } from './editor/editor'
import type { Doc } from './editor/document'
import { Workspace } from './workspace'
import { TabBar } from './tabBar'
import { CommandRegistry, keyString } from './keymap'
import { FindBar } from './findBar'
import { Panel } from './panel'
import { OutputView } from './outputView'
import { TerminalView } from './terminalView'

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
const panel = new Panel($('editor-pane'))
const output = new OutputView(
  (path, line) => void openFile(path, line - 1),
  (text) => void window.api.sendRunInput(text),
  { run: () => void runCurrentFile(), stop: () => void window.api.stopRun() }
)
panel.addView('output', 'Output', output.body, output.actions)
const terminal = new TerminalView(() => rootFolder)
panel.addView('terminal', 'Terminal', terminal.body, terminal.actions, () => terminal.show())

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

// ---------- running Python ----------

const parentDir = (path: string) => path.replace(/[\\/][^\\/]*$/, '')
let lastRunId = 0

async function runCurrentFile(): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  panel.show('output')
  output.begin(doc.path)
  if (!doc.path.toLowerCase().endsWith('.py')) {
    output.error('Run works with Python files (.py) for now.')
    return
  }
  // Auto-save before running, so Python sees what's in the editor.
  if (doc.dirty && !(await saveActive())) {
    output.error('Run cancelled: the file could not be saved.')
    return
  }
  await window.api.runPython(doc.path, rootFolder ?? parentDir(doc.path))
  editor.focus()
}

window.api.onRunEvent((e) => {
  if (e.runId < lastRunId) return // late event from a run we already replaced
  lastRunId = e.runId
  if (e.type === 'start') output.started(e.python)
  else if (e.type === 'output') output.append(e.stream, e.text)
  else if (e.type === 'error') output.error(e.message)
  else if (e.type === 'exit') output.finished(e.code, e.ms, e.signal)
})

commands.register({ id: 'run.file', title: 'Run Python File', keys: 'F5', when: hasDoc, run: runCurrentFile })
commands.register({ id: 'run.stop', title: 'Stop Running', keys: 'Shift+F5', run: () => void window.api.stopRun() })
commands.register({ id: 'panel.toggle', title: 'Toggle Bottom Panel', keys: 'Ctrl+J', run: () => panel.toggle() })
commands.register({ id: 'panel.output', title: 'Show Output', run: () => panel.show('output') })
commands.register({
  id: 'terminal.toggle', title: 'Toggle Terminal', keys: 'Ctrl+`',
  run: () => {
    if (panel.activeView === 'terminal' && terminal.hasFocus) {
      panel.hide()
      editor.focus()
    } else panel.show('terminal')
  }
})

$('run-file').addEventListener('click', () => void runCurrentFile())
$('stop-run').addEventListener('click', () => void window.api.stopRun())
$('open-folder').addEventListener('click', () => void openFolder())

// While typing in the terminal, keys belong to the shell (Ctrl+C, Ctrl+W, Ctrl+F...).
// Only these IDE shortcuts still work there.
const TERMINAL_PASSTHROUGH = new Set(['Ctrl+`', 'Ctrl+J', 'Ctrl+Shift+P', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'F5', 'Shift+F5', 'Ctrl+,'])

// Global shortcuts. Capture phase, so they win over the editor's own key handling.
window.addEventListener('keydown', (e) => {
  if (terminal.hasFocus && !TERMINAL_PASSTHROUGH.has(keyString(e))) return
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
