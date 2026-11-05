import { FileTree } from './fileTree'
import { Editor, type EditorOptions } from './editor/editor'
import type { Doc } from './editor/document'
import { OpenRefused, Workspace, isInside, samePath } from './workspace'
import { BackupKeeper } from './backups'
import { ENCODINGS, encodingLabel } from '../shared/encoding'
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
import { BreakpointStore } from './debug/breakpoints'
import { DebugSession, type PauseInfo, type StackFrame } from './debug/session'
import { DebugView } from './debug/debugView'
import { Completion } from './completion'
import { hoverSections } from './lsp/markdown'
import type { TooltipSection } from './tooltip'
import { wordStartAt } from './lsp/completionLogic'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const folderName = $('folder-name')
let rootFolder: string | null = null

const workspace = new Workspace(window.api, (doc: Doc) =>
  confirm(`${doc.name} has unsaved changes. Close it without saving?`)
)
// ---------- editors (one per tab group; two when the view is split) ----------

/** Callbacks for the editor of group `index`. */
const editorOptions = (index: number): EditorOptions => ({
  onEdit: (doc) => {
    workspace.notifyChanged()
    python.docChanged(doc)
    completion.onEdit()
  },
  onKeyDown: (e) => completion.handleKey(e),
  onType: (text) => completion.onType(text),
  onCtrlClick: (pos) => void goToDefinition(pos),
  onGutterClick: (line) => {
    workspace.focusGroup(index)
    toggleBreakpoint(line)
  },
  // Hover info is for the side you're working in.
  onMouseMove: (pos, e) => {
    if (index === workspace.activeGroup) onEditorHover(pos, e)
  },
  onMouseLeave: () => hideHover(),
  onFocus: () => workspace.focusGroup(index),
  onCursor: () => {
    if (index === workspace.activeGroup) scheduleStatus()
  }
})
const groupEls: HTMLElement[] = [$('group-0')]
const editors: Editor[] = [new Editor($('editor'), editorOptions(0))]
const tabBars: TabBar[] = [new TabBar($('tabs'), workspace, 0)]
let minimapOn = true

/**
 * "The editor": whichever side has focus. Find, autocomplete, the debugger
 * and every command talk to this, so they follow the active side.
 */
const editor = new Proxy({} as Editor, {
  get: (_target, key) => {
    const e = editors[workspace.activeGroup] ?? editors[0]
    const value = Reflect.get(e, key, e)
    return typeof value === 'function' ? value.bind(e) : value
  },
  set: (_target, key, value) => {
    for (const e of editors) Reflect.set(e, key, value, e)
    return true
  }
})

/** Add or remove the second editor to match the workspace's groups. */
function syncGroups(): void {
  const host = $('groups')
  while (editors.length < workspace.groups.length) {
    const i = editors.length
    const group = document.createElement('div')
    group.className = 'group'
    group.id = `group-${i}`
    const tabs = document.createElement('div')
    tabs.className = 'tabs'
    tabs.setAttribute('role', 'tablist')
    const slot = document.createElement('div')
    slot.className = 'editor-slot'
    group.append(tabs, slot)
    host.append(group)
    groupEls.push(group)
    const ed = new Editor(slot, editorOptions(i))
    ed.refreshLayout(settings.tabSize)
    ed.setMinimap(minimapOn)
    editors.push(ed)
    tabBars.push(new TabBar(tabs, workspace, i))
  }
  while (editors.length > workspace.groups.length) {
    groupEls.pop()!.remove()
    editors.pop()
    tabBars.pop()
  }
  host.classList.toggle('split', editors.length > 1)
  groupEls.forEach((g, i) => g.classList.toggle('active', i === workspace.activeGroup))
}
const tree = new FileTree($('file-tree'), {
  openFile: (path) => void openFile(path),
  created: (path, isDirectory) => {
    if (!isDirectory) void openFile(path).then(() => editor.focus())
    void refreshGit()
  },
  renamed: (oldPath, newPath) => {
    // The language server knows files by path: close the old ones, reopen under the new name.
    const moved = workspace.docsUnder(oldPath)
    python.syncDocs(workspace.docs.filter((d) => !moved.includes(d)))
    workspace.pathRenamed(oldPath, newPath)
    breakpoints.pathRenamed(oldPath, newPath)
    void refreshGit()
  },
  delete: async (path, isDirectory) => {
    const name = path.split(/[\\/]/).pop()
    const open = workspace.docsUnder(path)
    const unsaved = open.filter((d) => d.dirty).length
    const what = isDirectory ? `the folder "${name}" and everything in it` : `"${name}"`
    const warn = unsaved ? `\n\n${unsaved} open file${unsaved > 1 ? 's have' : ' has'} unsaved changes that will be lost.` : ''
    if (!confirm(`Delete ${what}?\nIt goes to the Recycle Bin, so you can get it back.${warn}`)) return false
    try {
      await window.api.trashEntry(path)
    } catch (err) {
      alert(`Couldn't delete ${path}:\n${String(err)}`)
      return false
    }
    workspace.discard(open)
    breakpoints.removeUnder(path)
    void refreshGit()
    return true
  },
  error: (message) => alert(message)
})
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

// ---------- debugger (debugpy over the Debug Adapter Protocol) ----------

const breakpoints = new BreakpointStore()
/** Docs whose edits we watch so their breakpoints move with the code. */
const watchedDocs = new WeakSet<Doc>()
let session: DebugSession | null = null
/** Where the paused program is (shown with a ▶ in the gutter and a highlighted line). */
let pausedAt: { path: string; line: number } | null = null
let debugFile: string | null = null

const debugView = new DebugView({
  continue: () => void session?.continue(),
  stepOver: () => void session?.stepOver(),
  stepInto: () => void session?.stepInto(),
  stepOut: () => void session?.stepOut(),
  stop: () => void stopDebugging(),
  restart: () => void restartDebugging(),
  selectFrame: (frame) => void showFrame(frame),
  scopes: (frameId) => session!.scopes(frameId),
  variables: (ref) => session!.variables(ref),
  evaluate: (expr) => {
    if (!session) return Promise.reject(new Error('Not debugging'))
    return session.evaluate(expr, debugView.currentFrame?.id)
  },
  openLink: (path, line) => void openFile(path, line - 1)
})
panel.addView('debug', 'Debug', debugView.body, debugView.actions, () => debugView.focusInput())

function watchDoc(doc: Doc): void {
  if (watchedDocs.has(doc)) return
  watchedDocs.add(doc)
  doc.buffer.subscribe((change) => breakpoints.applyChange(doc.path, change))
}

/** Draw breakpoints and the paused line for the file in the editor. */
function updateLineMarkers(): void {
  for (const ed of editors) {
    const doc = ed.currentDoc
    if (!doc) continue
    const exec = pausedAt && samePath(pausedAt.path, doc.path) ? pausedAt.line : null
    ed.setLineMarkers(breakpoints.linesFor(doc.path), exec)
  }
}

breakpoints.subscribe((path) => {
  updateLineMarkers()
  // Breakpoints changed while debugging: tell debugpy right away.
  void session?.setBreakpoints(path, breakpoints.linesFor(path)).catch(() => {})
})

function toggleBreakpoint(line = editor.getCursor().line): void {
  const doc = workspace.active
  if (doc) breakpoints.toggle(doc.path, line)
}

const debugging = () => session?.active === true
const debugPaused = () => session?.state === 'paused'

async function startDebugging(path = workspace.active?.path): Promise<void> {
  if (!path) return
  if (session?.active) await stopDebugging()
  panel.show('debug')
  debugView.begin(path)
  if (!path.toLowerCase().endsWith('.py')) {
    debugView.error('Debugging works with Python files (.py).')
    return
  }
  // Save every open file first: debugpy reads the files from disk.
  for (const doc of workspace.docs.filter((d) => d.dirty)) {
    try {
      await workspace.save(doc)
      python.didSave(doc)
    } catch (err) {
      debugView.error(`Debugging cancelled: couldn't save ${doc.name} (${String(err)})`)
      return
    }
  }
  const cwd = rootFolder ?? parentDir(path)
  debugView.setState('starting')
  const prep = await window.api.debugPrepare(cwd, settings.pythonPath || undefined)
  if (!prep.python) {
    debugView.error('Python was not found. Install it from python.org, or pick an interpreter in Settings (Ctrl+,).')
    debugView.setState('idle')
    return
  }
  if (!prep.hasDebugpy) {
    const ok = confirm(
      `The debugger needs the "debugpy" package, which isn't installed for:\n${prep.python}\n\nInstall it now? (runs: pip install debugpy)`
    )
    if (!ok) {
      debugView.error(`Debugging needs debugpy. Install it with:\n  "${prep.python}" -m pip install debugpy`)
      debugView.setState('idle')
      return
    }
    debugView.output('console', 'Installing debugpy (pip install debugpy)…\n')
    const res = await window.api.debugInstall(prep.python)
    const tail = res.output.split(/\r?\n/).filter(Boolean).slice(-4).join('\n')
    debugView.output(res.ok ? 'console' : 'stderr', tail + '\n')
    if (!res.ok) {
      debugView.error('Installing debugpy failed (see above).')
      debugView.setState('idle')
      return
    }
  }
  debugView.started(prep.python)
  debugFile = path

  const s: DebugSession = new DebugSession({
    send: (m) => window.api.debugSend(m),
    onState: (state) => {
      if (session !== s) return
      debugView.setState(state)
      if (state === 'running' && pausedAt) {
        pausedAt = null
        updateLineMarkers()
      }
    },
    onOutput: (category, text) => {
      if (session === s) debugView.output(category, text)
    },
    onPaused: (info) => {
      if (session === s) void onPaused(info)
    },
    onEnded: (code) => {
      if (session !== s) return
      pausedAt = null
      updateLineMarkers()
      debugView.setState('idle')
      debugView.ended(code)
      void window.api.debugStop()
    }
  })
  session = s
  await window.api.debugStart(prep.python, cwd)
  try {
    await s.start({ program: path, cwd, breakpoints: breakpoints.all() })
  } catch (err) {
    if (session !== s || !s.active) return
    debugView.error(`Couldn't start debugging: ${err instanceof Error ? err.message : String(err)}`)
    await s.stop()
  }
}

async function onPaused(info: PauseInfo): Promise<void> {
  debugView.showPaused(info)
  panel.show('debug')
  const frame = debugView.currentFrame
  if (frame) await showFrame(frame)
}

/** Open a stack frame's file at its line and mark it as the paused line. */
async function showFrame(frame: StackFrame): Promise<void> {
  if (!frame.path) return
  pausedAt = { path: frame.path, line: frame.line }
  if (await openFile(frame.path)) editor.goTo(frame.line, frame.col)
  updateLineMarkers()
}

async function stopDebugging(): Promise<void> {
  await session?.stop()
}

async function restartDebugging(): Promise<void> {
  const file = debugFile
  await stopDebugging()
  if (file) await startDebugging(file)
}

window.api.onDebugMessage((m) => session?.handleMessage(m))
window.api.onDebugExit((info) => {
  if (!session?.active) return
  if (info.error) debugView.error(info.error)
  session.adapterExited()
})

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
  for (const ed of editors) {
    const doc = ed.currentDoc
    ed.setSquiggles(doc ? python.diagnosticsFor(doc.path) : [])
  }
  const count = problems.render(python.allDiagnostics())
  panel.setTitle('problems', count ? `Problems (${count})` : 'Problems')
}
python.onDiagnostics(showDiagnostics)
const completion = new Completion(editor, python, () => workspace.active)

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
    python.syncDocs(workspace.docs.filter((d) => !d.large))
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

// ---------- hover tooltips (errors + type info under the mouse) ----------

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

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)

function onEditorHover(pos: { line: number; col: number } | null, e: MouseEvent): void {
  const doc = workspace.active
  if (!pos || !doc) {
    hideHover()
    return
  }
  const hits = python.diagnosticsFor(doc.path).filter((d) => d.severity <= 3 && covers(d, pos))
  // Hovering anywhere on the same word (or same set of errors) keeps the same tooltip.
  const lineText = doc.buffer.getLine(pos.line)
  const onWord = isWordChar(lineText[pos.col])
  const wordStart = onWord ? wordStartAt(lineText, pos.col + 1) : -1
  const key = `${doc.path}:${pos.line}:${wordStart}|${hits.map((d) => d.message).join('|')}`
  if (key === hoverKey) return
  hideHover()
  if (!hits.length && !onWord) return
  hoverKey = key
  const anchor = { left: e.clientX, top: e.clientY - 10, bottom: e.clientY + 10 }
  hoverTimer = window.setTimeout(async () => {
    const sections: TooltipSection[] = hits.map((d) => ({
      kind: SEVERITY_LABEL[d.severity],
      text: `${d.message}${d.code ? `  (${d.code})` : ''}`
    }))
    if (onWord && debugPaused()) {
      const expr = expressionAt(lineText, pos.col)
      try {
        const { result } = await session!.evaluate(expr, debugView.currentFrame?.id, 'hover')
        sections.push({ kind: 'code', text: `${expr} = ${result}` })
      } catch {
        // not a variable here (e.g. a keyword): nothing to show
      }
    }
    if (onWord) {
      try {
        const md = await python.hover(doc, pos)
        if (md) sections.push(...hoverSections(md))
      } catch {
        // server busy: show what we have
      }
    }
    if (hoverKey !== key || !sections.length) return // mouse moved on meanwhile
    tooltip.show(sections, anchor)
  }, 400)
}

/** The dotted name under the cursor, e.g. "self.items" when hovering "items". */
function expressionAt(line: string, col: number): string {
  let start = col
  while (start > 0 && /[\p{L}\p{N}_.]/u.test(line[start - 1])) start--
  let end = col
  while (end < line.length && /[\p{L}\p{N}_]/u.test(line[end])) end++
  return line.slice(start, end).replace(/^\.+/, '')
}

// ---------- go to definition (F12 / Ctrl+click) and back (Alt+Left) ----------

const navigationStack: { path: string; line: number; col: number }[] = []

async function goToDefinition(pos = editor.getCursor()): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  hideHover()
  let target
  try {
    target = await python.definition(doc, pos)
  } catch {
    return
  }
  if (!target) return
  navigationStack.push({ path: doc.path, line: pos.line, col: pos.col })
  if (navigationStack.length > 50) navigationStack.shift()
  if (await openFile(target.path)) editor.select(target.start, target.end)
  editor.focus()
}

async function goBack(): Promise<void> {
  const prev = navigationStack.pop()
  if (!prev) return
  if (await openFile(prev.path)) editor.goTo(prev.line, prev.col)
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
  for (const ed of editors) ed.refreshLayout(s.tabSize)
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
  syncGroups()
  workspace.groups.forEach((g, i) => {
    tabBars[i].render()
    const ed = editors[i]
    if (g.active !== ed.currentDoc || !g.active) {
      // Only the active side takes keyboard focus.
      if (g.active) ed.show(g.active, i === workspace.activeGroup)
      else ed.showPlaceholder(rootFolder ? 'Pick a file from the tree' : 'Open a folder and pick a file')
    }
  })
  const doc = workspace.active
  // Find highlights belong to the side being searched.
  editors.forEach((ed, i) => { if (i !== workspace.activeGroup) ed.setMatches([]) })
  tree.highlight(doc?.path ?? null)
  for (const d of workspace.docs) watchDoc(d)
  updateLineMarkers()
  findBar.refresh()
  completion.syncDoc()
  python.syncDocs(workspace.docs.filter((d) => !d.large))
  backups.sync(workspace.docs)
  scheduleStatus()
  showDiagnostics()
  const folder = rootFolder?.split(/[\\/]/).pop()
  document.title = [doc ? (doc.dirty ? '● ' : '') + doc.name : null, folder, 'IDEforfun']
    .filter(Boolean).join(' — ')
})

export async function openFile(path: string, line?: number): Promise<Doc | null> {
  const name = path.split(/[\\/]/).pop()
  try {
    let doc: Doc
    try {
      doc = await workspace.open(path)
    } catch (err) {
      // Binary and very big files ask first.
      if (!(err instanceof OpenRefused) || err.reason === 'tooLarge') throw err
      const mb = (err.size / 1048576).toFixed(1)
      const question = err.reason === 'binary'
        ? `${name} looks like a binary file (not text), so it may show as gibberish.\n\nOpen it as text anyway?`
        : `${name} is large (${mb} MB) and may be slow to edit.\n\nOpen it anyway?`
      if (!confirm(question)) return null
      doc = await workspace.open(path, { force: true })
    }
    if (line !== undefined) editor.goTo(line)
    return doc
  } catch (err) {
    alert(`Can't open ${path}:\n${err instanceof Error ? err.message : String(err)}`)
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
  await offerRestore(folder)
}

// ---------- crash recovery ----------

/** Keeps a backup of every unsaved file; left-over backups mean the app didn't close properly. */
const backups = new BackupKeeper(window.api)

/** Offer to bring back unsaved changes to files in `folder` that were lost in a crash. */
async function offerRestore(folder: string): Promise<void> {
  let found
  try {
    found = (await window.api.backupList()).filter((b) => isInside(b.path, folder))
  } catch {
    return
  }
  if (!found.length || rootFolder !== folder) return
  const rel = (p: string) => p.slice(folder.length).replace(/^[\\/]+/, '')
  const list = found.slice(0, 8).map((b) => `  • ${rel(b.path)}`).join('\n') + (found.length > 8 ? `\n  …and ${found.length - 8} more` : '')
  const restore = confirm(
    `IDEforfun didn't close properly last time, and ${found.length} file${found.length > 1 ? 's had' : ' had'} unsaved changes:\n\n${list}\n\n` +
    'Restore those changes? (They open as unsaved; Ctrl+Z goes back to the file on disk.) Cancel throws them away.'
  )
  if (!restore) {
    for (const b of found) void window.api.backupRemove(b.path)
    return
  }
  for (const b of found) {
    const doc = await openFile(b.path)
    if (!doc) continue // deleted or unreadable: the alert said so
    // One undoable step from the file on disk to the backed-up text.
    if (doc.buffer.getLines().join('\n') !== b.text) {
      doc.history.transact('other', { line: 0, col: 0 }, () => {
        doc.buffer.delete({ line: 0, col: 0 }, doc.buffer.clamp({ line: Infinity, col: Infinity }))
        return doc.buffer.insert({ line: 0, col: 0 }, b.text)
      })
    }
    doc.eol = b.eol
    doc.encoding = b.encoding
    python.docChanged(doc)
  }
  workspace.notifyChanged()
}

// ---------- commands ----------

const hasDoc = () => workspace.active !== null

commands.register({ id: 'file.openFolder', title: 'Open Folder…', keys: 'Ctrl+O', run: openFolder })
commands.register({ id: 'file.save', title: 'Save', keys: 'Ctrl+S', when: hasDoc, run: () => void saveActive() })
const hasFolder = () => rootFolder !== null
/** New items go next to the open file, or wherever is selected in the tree. */
const newItem = (isDirectory: boolean) => {
  showSidebar('files')
  void tree.startCreate(isDirectory)
}
commands.register({ id: 'file.new', title: 'New File…', keys: 'Ctrl+N', when: hasFolder, run: () => newItem(false) })
commands.register({ id: 'file.newFolder', title: 'New Folder…', when: hasFolder, run: () => newItem(true) })
commands.register({
  id: 'file.rename', title: 'Rename Current File…', when: hasDoc,
  run: () => {
    showSidebar('files')
    void tree.startRename(workspace.active!.path)
  }
})
commands.register({
  id: 'file.delete', title: 'Delete Current File', when: hasDoc,
  run: () => void tree.deleteEntry({ name: workspace.active!.name, path: workspace.active!.path, isDirectory: false })
})
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

commands.register({
  id: 'run.smart', title: 'Run (or Debug if there are breakpoints) / Continue', keys: 'F5',
  when: () => hasDoc() || debugPaused(),
  run: () => {
    if (debugPaused()) return void session!.continue()
    if (debugging()) return // starting or running: nothing to do
    if (breakpoints.count > 0) return void startDebugging()
    void runCurrentFile()
  }
})
commands.register({ id: 'run.file', title: 'Run Python File (without debugging)', keys: 'Ctrl+F5', when: hasDoc, run: runCurrentFile })
commands.register({
  id: 'run.stop', title: 'Stop Running / Debugging', keys: 'Shift+F5',
  run: () => (debugging() ? void stopDebugging() : void window.api.stopRun())
})
commands.register({ id: 'debug.start', title: 'Start Debugging', when: () => hasDoc() && !debugging(), run: () => void startDebugging() })
commands.register({ id: 'debug.restart', title: 'Restart Debugging', keys: 'Ctrl+Shift+F5', when: debugging, run: () => void restartDebugging() })
commands.register({ id: 'debug.stepOver', title: 'Step Over', keys: 'F10', when: debugPaused, run: () => void session!.stepOver() })
commands.register({ id: 'debug.stepInto', title: 'Step Into', keys: 'F11', when: debugPaused, run: () => void session!.stepInto() })
commands.register({ id: 'debug.stepOut', title: 'Step Out', keys: 'Shift+F11', when: debugPaused, run: () => void session!.stepOut() })
commands.register({ id: 'debug.pause', title: 'Pause', when: () => session?.state === 'running', run: () => void session!.pause() })
commands.register({ id: 'debug.toggleBreakpoint', title: 'Toggle Breakpoint', keys: 'F9', when: hasDoc, run: () => toggleBreakpoint() })
commands.register({ id: 'debug.clearBreakpoints', title: 'Remove All Breakpoints', when: () => breakpoints.count > 0, run: () => breakpoints.clear() })
commands.register({
  id: 'editor.toggleMinimap', title: 'Toggle Minimap',
  run: () => {
    minimapOn = !minimapOn
    for (const ed of editors) ed.setMinimap(minimapOn)
    try { localStorage.setItem('ideforfun.minimap', minimapOn ? '1' : '0') } catch { /* storage unavailable */ }
  }
})
try {
  if (localStorage.getItem('ideforfun.minimap') === '0') {
    minimapOn = false
    for (const ed of editors) ed.setMinimap(false)
  }
} catch { /* storage unavailable */ }
const focusGroup = (i: number) => {
  if (!workspace.groups[i]) return
  workspace.focusGroup(i)
  editor.focus()
}
commands.register({ id: 'view.split', title: 'Split Editor (or switch sides)', keys: 'Ctrl+\\', when: hasDoc, run: () => { workspace.split(); editor.focus() } })
commands.register({ id: 'view.moveToOtherGroup', title: 'Move Tab to the Other Side', when: hasDoc, run: () => { workspace.moveToOtherGroup(); editor.focus() } })
commands.register({ id: 'view.focusLeft', title: 'Focus Left Editor', keys: 'Ctrl+1', run: () => focusGroup(0) })
commands.register({ id: 'view.focusRight', title: 'Focus Right Editor', keys: 'Ctrl+2', run: () => focusGroup(1) })
commands.register({ id: 'editor.fold', title: 'Fold Block (Ctrl+Shift+[)', when: hasDoc, run: () => editor.fold() })
commands.register({ id: 'editor.unfold', title: 'Unfold Block (Ctrl+Shift+])', when: hasDoc, run: () => editor.unfold() })
commands.register({ id: 'editor.foldAll', title: 'Fold All', when: hasDoc, run: () => editor.foldAll() })
commands.register({ id: 'editor.unfoldAll', title: 'Unfold All', when: hasDoc, run: () => editor.unfoldAll() })
commands.register({ id: 'panel.debug', title: 'Show Debug Panel', run: () => panel.show('debug') })
commands.register({ id: 'panel.toggle', title: 'Toggle Bottom Panel', keys: 'Ctrl+J', run: () => panel.toggle() })
commands.register({ id: 'panel.output', title: 'Show Output', run: () => panel.show('output') })
commands.register({ id: 'nav.definition', title: 'Go to Definition', keys: 'F12', when: hasDoc, run: () => void goToDefinition() })
commands.register({ id: 'nav.back', title: 'Go Back', keys: 'Alt+ArrowLeft', run: () => void goBack() })
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
// ---------- status bar ----------

let statusFrame = 0
function scheduleStatus(): void {
  if (statusFrame) return
  statusFrame = requestAnimationFrame(() => {
    statusFrame = 0
    updateStatus()
  })
}

function updateStatus(): void {
  const doc = workspace.active
  const set = (id: string, text: string) => {
    const el = $(id)
    if (el.textContent !== text) el.textContent = text
  }
  if (doc) {
    const c = editor.getCursor()
    const selected = editor.getSelectedText().length
    const cursors = editor.cursorCount
    set('sb-cursor', `Ln ${c.line + 1}, Col ${c.col + 1}` + (cursors > 1 ? ` (${cursors} cursors)` : selected ? ` (${selected} selected)` : ''))
    set('sb-indent', `Spaces: ${settings.tabSize}`)
    set('sb-encoding', encodingLabel(doc.encoding))
    set('sb-eol', doc.eol)
    const lang = doc.path.toLowerCase().endsWith('.py') ? 'Python' : 'Plain Text'
    set('sb-lang', doc.large ? `${lang} (large file: no error checking)` : lang)
  } else {
    for (const id of ['sb-cursor', 'sb-indent', 'sb-encoding', 'sb-eol', 'sb-lang']) set(id, '')
  }
  const all = python.allDiagnostics()
  const errors = all.reduce((n, [, list]) => n + list.filter((d) => d.severity === 1).length, 0)
  const warnings = all.reduce((n, [, list]) => n + list.filter((d) => d.severity === 2).length, 0)
  const problemsEl = $('sb-problems')
  const key = rootFolder ? `${errors}|${warnings}` : ''
  if (problemsEl.dataset.key !== key) {
    problemsEl.dataset.key = key
    problemsEl.replaceChildren()
    if (rootFolder) {
      const e = document.createElement('span')
      e.className = errors ? 'err' : ''
      e.textContent = `⊗ ${errors}`
      const w = document.createElement('span')
      w.className = warnings ? 'warn' : ''
      w.textContent = `  ⚠ ${warnings}`
      problemsEl.append(e, w)
    }
  }
  set('sb-debug', session?.state === 'paused' ? '🐞 Paused' : session?.active ? '🐞 Debugging' : '')
}

function changeLineEndings(): void {
  const doc = workspace.active
  if (!doc) return
  palette.choose('Line endings for this file', (['LF', 'CRLF'] as const).map((eol) => ({
    label: eol,
    detail: eol === 'LF' ? 'Unix / macOS style (\\n)' : 'Windows style (\\r\\n)',
    hint: doc.eol === eol ? 'current' : undefined,
    run: () => {
      doc.eol = eol
      workspace.notifyChanged()
    }
  })))
}

function reopenWithEncoding(): void {
  const doc = workspace.active
  if (!doc) return
  palette.choose('Reopen with encoding (reads the file again)', ENCODINGS.map((e) => ({
    label: e.label,
    hint: doc.encoding === e.id ? 'current' : undefined,
    run: () => {
      if (doc.dirty && !confirm(`${doc.name} has unsaved changes. Reopen it and lose them?`)) return
      void workspace.reopenWithEncoding(doc, e.id).catch((err) => alert(`Couldn't reopen ${doc.name}:\n${String(err)}`))
    }
  })))
}

function saveWithEncoding(): void {
  const doc = workspace.active
  if (!doc) return
  palette.choose('Save with encoding', ENCODINGS.map((e) => ({
    label: e.label,
    hint: doc.encoding === e.id ? 'current' : undefined,
    run: () => {
      doc.encoding = e.id
      void saveActive()
    }
  })))
}

commands.register({ id: 'file.lineEndings', title: 'Change Line Endings (LF / CRLF)…', when: hasDoc, run: changeLineEndings })
commands.register({ id: 'file.reopenEncoding', title: 'Reopen with Encoding…', when: hasDoc, run: reopenWithEncoding })
commands.register({ id: 'file.saveEncoding', title: 'Save with Encoding…', when: hasDoc, run: saveWithEncoding })

$('sb-eol').addEventListener('click', changeLineEndings)
$('sb-encoding').addEventListener('click', () => {
  palette.choose('Encoding', [
    { label: 'Reopen with Encoding…', detail: 'read the file again as another encoding', run: () => setTimeout(reopenWithEncoding) },
    { label: 'Save with Encoding…', detail: 'write the file in another encoding', run: () => setTimeout(saveWithEncoding) }
  ])
})
$('sb-cursor').addEventListener('click', () => void palette.open(':'))
$('sb-indent').addEventListener('click', () => commands.run('settings.open'))
$('sb-problems').addEventListener('click', () => panel.show('problems'))
python.onDiagnostics(scheduleStatus)
updateStatus()

commands.register({ id: 'palette.commands', title: 'Show All Commands', keys: 'Ctrl+Shift+P', run: () => void palette.open('>') })
commands.register({ id: 'palette.files', title: 'Go to File…', keys: 'Ctrl+P', when: () => rootFolder !== null, run: () => void palette.open('') })
commands.register({ id: 'palette.line', title: 'Go to Line…', keys: 'Ctrl+G', when: hasDoc, run: () => void palette.open(':') })

$('open-settings').addEventListener('click', () => settingsView.open())
$('run-file').addEventListener('click', () => void runCurrentFile())
$('debug-file').addEventListener('click', () => void startDebugging())
$('stop-run').addEventListener('click', () => void window.api.stopRun())
$('open-folder').addEventListener('click', () => void openFolder())

// While typing in the terminal, keys belong to the shell (Ctrl+C, Ctrl+W, Ctrl+F...).
// Only these IDE shortcuts still work there.
const TERMINAL_PASSTHROUGH = new Set(['Ctrl+`', 'Ctrl+J', 'Ctrl+Shift+P', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'F5', 'Shift+F5', 'Ctrl+,', 'Ctrl+F5', 'Ctrl+Shift+F5', 'F9', 'F10', 'F11', 'Shift+F11'])

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
