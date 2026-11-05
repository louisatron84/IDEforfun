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
import { SettingsView } from './settingsView'
import { Palette } from './palette'
import { SearchView } from './searchView'
import { LspClient } from './lsp/client'
import { PythonLanguage, type Diagnostic } from './lsp/python'
import { ProblemsView } from './problemsView'
import { Tooltip } from './tooltip'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const folderName = $('folder-name')
let rootFolder: string | null = null

const workspace = new Workspace(window.api, (doc: Doc) =>
  confirm(`${doc.name} has unsaved changes. Close it without saving?`)
)
const editor = new Editor($('editor'), {
  onEdit: (doc) => {
    workspace.notifyChanged()
    python.docChanged(doc)
  },
  onMouseMove: (pos, e) => onEditorHover(pos, e),
  onMouseLeave: () => hideHover()
})
const tabBar = new TabBar($('tabs'), workspace)
const tree = new FileTree($('file-tree'), (entry) => void openFile(entry.path))
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

// ---------- Python language server (Pyright) ----------

const lsp = new LspClient((m) => window.api.lspSend(m))
window.api.onLspMessage((m) => lsp.handleMessage(m))
const python = new PythonLanguage(lsp)
const problems = new ProblemsView(
  (path, d) => void openFile(path).then((doc) => {
    if (doc) editor.select(d.start, d.end)
    editor.focus()
  }),
  (path) => {
    // Compare ignoring slash direction and case (Windows), then show the part inside the folder.
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    return rootFolder && norm(path).startsWith(norm(rootFolder) + '/') ? path.slice(rootFolder.length + 1) : path
  }
)
panel.addView('problems', 'Problems', problems.body, problems.actions)

function showDiagnostics(): void {
  const doc = workspace.active
  editor.setSquiggles(doc ? python.diagnosticsFor(doc.path) : [])
  const count = problems.render(python.allDiagnostics())
  panel.setTitle('problems', count ? `Problems (${count})` : 'Problems')
}
python.onDiagnostics(showDiagnostics)

let lspRestarts = 0
async function startLanguageServer(): Promise<void> {
  if (!rootFolder) return
  lsp.dispose('Python language server restarting')
  python.stopped()
  problems.setStatus('Starting Python language server (Pyright)…')
  showDiagnostics()
  try {
    await window.api.lspStart()
    const py = await window.api.resolvePythonForAnalysis(rootFolder, settings.pythonPath || undefined)
    await python.start(rootFolder, py)
    python.syncDocs(workspace.docs)
    problems.setStatus('')
  } catch (err) {
    problems.setStatus(`Python language server failed to start: ${String(err)}`)
  }
  showDiagnostics()
}
window.api.onLspExit((code) => {
  lsp.dispose('Python language server stopped')
  python.stopped()
  // Restart after an unexpected crash, but don't loop forever.
  if (lspRestarts++ < 3) void startLanguageServer()
  else {
    problems.setStatus(`Python language server stopped (exit code ${code}). Reopen the folder to retry.`)
    showDiagnostics()
  }
})

// ---------- hover tooltips (errors under the mouse) ----------

const tooltip = new Tooltip()
let hoverTimer: number | undefined
let hoverKey = ''
const SEVERITY_LABEL: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

function hideHover(): void {
  window.clearTimeout(hoverTimer)
  hoverKey = ''
  tooltip.hide()
}

function covers(d: Diagnostic, pos: { line: number; col: number }): boolean {
  const afterStart = pos.line > d.start.line || (pos.line === d.start.line && pos.col >= d.start.col)
  const zeroWidth = d.start.line === d.end.line && d.start.col === d.end.col
  const beforeEnd = pos.line < d.end.line || (pos.line === d.end.line && (pos.col < d.end.col || (zeroWidth && pos.col === d.end.col)))
  return afterStart && beforeEnd
}

function onEditorHover(pos: { line: number; col: number } | null, e: MouseEvent): void {
  const doc = workspace.active
  const hits = pos && doc ? python.diagnosticsFor(doc.path).filter((d) => d.severity <= 3 && covers(d, pos)) : []
  const key = hits.map((d) => d.message).join('|')
  if (key === hoverKey) return
  hideHover()
  if (!hits.length) return
  hoverKey = key
  const anchor = { left: e.clientX, top: e.clientY - 10, bottom: e.clientY + 10 }
  hoverTimer = window.setTimeout(() => {
    tooltip.show(hits.map((d) => ({
      kind: SEVERITY_LABEL[d.severity],
      text: `${d.message}${d.code ? `  (${d.code})` : ''}`
    })), anchor)
  }, 350)
}

// ---------- settings ----------

let settings: Settings = DEFAULT_SETTINGS

function applySettings(s: Settings): void {
  const pythonChanged = s.pythonPath !== settings.pythonPath
  settings = s
  if (pythonChanged && rootFolder) void startLanguageServer()
  const root = document.documentElement
  root.style.setProperty('--code-size', `${s.fontSize}px`)
  root.style.setProperty('--line-height', `${Math.round(s.fontSize * 1.45)}px`)
  root.style.setProperty('--tab-size', String(s.tabSize))
  root.dataset.theme = s.theme
  editor.refreshLayout(s.tabSize)
  terminal.applyTheme(s.fontSize)
}

const settingsView = new SettingsView(settings, (s) => {
  applySettings(s)
  void window.api.saveSettings(s)
})
void window.api.getSettings().then((s) => {
  applySettings(s)
  settingsView.set(s)
})

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
  python.syncDocs(workspace.docs)
  showDiagnostics()
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
    python.didSave(doc)
    void refreshGit()
    // Project search reads files from disk: refresh visible results after saving.
    if (!$('search-panel').hidden) searchView.refresh()
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
  void refreshGit()
  lspRestarts = 0
  void startLanguageServer()
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
  await window.api.runPython(doc.path, rootFolder ?? parentDir(doc.path), settings.pythonPath || undefined)
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
commands.register({ id: 'panel.problems', title: 'Show Problems', keys: 'Ctrl+Shift+M', run: () => panel.show('problems') })
commands.register({ id: 'python.restartServer', title: 'Restart Python Language Server', when: () => rootFolder !== null, run: () => { lspRestarts = 0; void startLanguageServer() } })
commands.register({
  id: 'terminal.toggle', title: 'Toggle Terminal', keys: 'Ctrl+`',
  run: () => {
    if (panel.activeView === 'terminal' && terminal.hasFocus) {
      panel.hide()
      editor.focus()
    } else panel.show('terminal')
  }
})

commands.register({ id: 'settings.open', title: 'Open Settings', keys: 'Ctrl+,', run: () => settingsView.isOpen ? settingsView.close() : settingsView.open() })
commands.register({
  id: 'view.zoomIn', title: 'Increase Font Size', keys: 'Ctrl+=',
  run: () => { const s = { ...settings, fontSize: Math.min(28, settings.fontSize + 1) }; applySettings(s); settingsView.set(s); void window.api.saveSettings(s) }
})
commands.register({
  id: 'view.zoomOut', title: 'Decrease Font Size', keys: 'Ctrl+-',
  run: () => { const s = { ...settings, fontSize: Math.max(10, settings.fontSize - 1) }; applySettings(s); settingsView.set(s); void window.api.saveSettings(s) }
})
commands.register({
  id: 'view.toggleTheme', title: 'Toggle Light/Dark Theme',
  run: () => { const s: Settings = { ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' }; applySettings(s); settingsView.set(s); void window.api.saveSettings(s) }
})

// ---------- git status in the file tree ----------

let gitBusy = false
async function refreshGit(): Promise<void> {
  if (!rootFolder || gitBusy) return
  gitBusy = true
  try {
    tree.setGitStatus(await window.api.gitStatus(rootFolder))
  } finally {
    gitBusy = false
  }
}
// Pick up changes made outside the editor (terminal, other apps): on focus and every few seconds.
window.addEventListener('focus', () => void refreshGit())
window.setInterval(() => {
  if (document.hasFocus()) void refreshGit()
}, 5000)

// ---------- sidebar: Files | Search ----------

const searchView = new SearchView(
  () => rootFolder,
  async (path, line, col, length) => {
    if (await openFile(path)) editor.select({ line, col }, { line, col: col + length })
    editor.focus()
  }
)
$('search-panel').append(searchView.root)

function showSidebar(view: 'files' | 'search'): void {
  $('file-tree').hidden = view !== 'files'
  $('search-panel').hidden = view !== 'search'
  for (const b of document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === view))
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs button')) {
  b.addEventListener('click', () => {
    showSidebar(b.dataset.view as 'files' | 'search')
    if (b.dataset.view === 'search') searchView.focus()
  })
}
commands.register({
  id: 'search.project', title: 'Search in Project', keys: 'Ctrl+Shift+F', when: () => rootFolder !== null,
  run: () => {
    showSidebar('search')
    searchView.focus(editor.getSelectedText() || undefined)
  }
})
commands.register({ id: 'view.files', title: 'Show Files', keys: 'Ctrl+Shift+E', run: () => showSidebar('files') })

// ---------- command palette / quick open / go to line ----------

const palette = new Palette({
  commands,
  listFiles: async () => (rootFolder ? window.api.listFiles(rootFolder) : []),
  openFile: (path) => void openFile(path),
  goToLine: (line) => editor.goTo(line),
  lineCount: () => workspace.active?.buffer.lineCount ?? null
})
commands.register({ id: 'palette.commands', title: 'Show All Commands', keys: 'Ctrl+Shift+P', run: () => void palette.open('>') })
commands.register({ id: 'palette.files', title: 'Go to File…', keys: 'Ctrl+P', when: () => rootFolder !== null, run: () => void palette.open('') })
commands.register({ id: 'palette.line', title: 'Go to Line…', keys: 'Ctrl+G', when: hasDoc, run: () => void palette.open(':') })

$('open-settings').addEventListener('click', () => settingsView.open())
$('run-file').addEventListener('click', () => void runCurrentFile())
$('stop-run').addEventListener('click', () => void window.api.stopRun())
$('open-folder').addEventListener('click', () => void openFolder())

// While typing in the terminal, keys belong to the shell (Ctrl+C, Ctrl+W, Ctrl+F...).
// Only these IDE shortcuts still work there.
const TERMINAL_PASSTHROUGH = new Set(['Ctrl+`', 'Ctrl+J', 'Ctrl+Shift+P', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'F5', 'Shift+F5', 'Ctrl+,'])

// Global shortcuts. Capture phase, so they win over the editor's own key handling.
window.addEventListener('keydown', (e) => {
  const key = keyString(e)
  if (terminal.hasFocus && !TERMINAL_PASSTHROUGH.has(key)) return
  // Dialogs handle their own keys (Escape, arrows...); only their toggles pass through.
  if (settingsView.isOpen && key !== 'Ctrl+,') return
  if (palette.isOpen && !['Ctrl+Shift+P', 'Ctrl+P', 'Ctrl+G'].includes(key)) return
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
