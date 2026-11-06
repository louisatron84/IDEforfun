// Forge's fonts, bundled so they work offline (Space Grotesk for the interface, JetBrains Mono for code).
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import { FileTree } from './fileTree'
import { Editor, type EditorOptions } from './editor/editor'
import type { Doc } from './editor/document'
import type { Position } from './editor/textBuffer'
import { OpenRefused, Workspace, isInside, samePath } from './workspace'
import { BackupKeeper } from './backups'
import { ENCODINGS, encodingLabel } from '../shared/encoding'
import { TabBar } from './tabBar'
import { CommandRegistry, keyString } from './keymap'
import { FindBar } from './findBar'
import { DockView } from './dock/dockView'
import { TaskController } from './dock/tasks'
import { createPanelFacade } from './dock/facade'
import { EditBar } from './dock/editBar'
import { TASKS, type TaskId } from '../shared/layouts'
import { OutputView } from './outputView'
import { TerminalView } from './terminalView'
import { SettingsView } from './settingsView'
import { Palette } from './palette'
import { SearchView } from './searchView'
import { LspClient } from './lsp/client'
import { LspServer, type Diagnostic, type ServerConfig } from './lsp/server'
import { LanguageServices } from './lsp/services'
import { pyright } from './lsp/pyright'
import { ProblemsView } from './problemsView'
import { Tooltip } from './tooltip'
import { BreakpointStore, breakpointStyle } from './debug/breakpoints'
import { DebugSession, type ChildConfig, type ExceptionFilter, type PauseInfo, type StackFrame, type Variable } from './debug/session'
import { DebugView } from './debug/debugView'
import { Completion } from './completion'
import { hoverSections } from './lsp/markdown'
import type { TooltipSection } from './tooltip'
import { wordStartAt } from './lsp/completionLogic'
import { DEFAULT_SETTINGS, effectiveSettings, type ProjectSettings, type Settings } from '../shared/settings'
import type { WorkspaceState } from '../shared/projectState'
import { Shortcuts } from './shortcuts'
import { PythonEnv, type PythonTool } from './pythonEnv'
import { TestView } from './testView'
import { WelcomePage } from './welcome'
import { CodeTools } from './codeTools'
import { GitView } from './gitView'
import { DiffView } from './diffView'
import { GraphView } from './graph/graphView'
import { buildGraph, type ProjectGraph } from '../shared/projectGraph'
import { WhereView } from './panels/whereView'
import { InFileView } from './panels/inFileView'
import { moduleForPath } from './panels/whereModel'
import { BoxController, type BoxFiles } from './boxes/controller'
import { BoxSettings } from './boxes/boxSettings'
import { Toolbox } from './boxes/toolbox'
import { lineDiff as codeLineDiff, showCodeDialog } from './boxes/codeDialog'
import { serializeBoxes } from '../shared/boxes'
import { parseTrace, planFrame, planNetSpark } from './graph/liveRun'
import { NetworkView } from './networkView'
import { DebugTrail, frameNode } from './graph/debugTrail'
import { GROUP_ROWS, historyView as debugHistoryView, valueCard } from './graph/debugCards'
import { drawObjectGraph } from './graph/objectGraph'
import { objectGraphExpression, parseObjectGraph } from '../shared/objectGraph'
import { funcLabel } from '../shared/network'
import { drawRecursionTree, parseRec, RecursionStore } from './graph/recursionTree'
import type { TraceTick } from './graph/liveRun'
import { NetLog, parseNet, stateOf } from '../shared/network'
import { HistoryView } from './historyView'
import { conflictNear, findConflicts, resolveConflict, type Conflict, type Resolution } from '../shared/conflicts'
import { timeAgo, type BlameLine } from '../shared/history'
import { lineDiff } from '../shared/lint'
import { ReferencesView } from './referencesView'
import { CallHierarchyView } from './callHierarchyView'
import { OutlineView } from './outlineView'
import { applyEdits, methodInClass, subclassAt, symbolPathAt, type DocSymbol, type FileEdits, type Location, type TextEdit, SYMBOL_KIND } from './lsp/navigation'
import { isTestFile } from '../shared/tests'
import { normalizeRunFile, resolveConfiguration, resolveTask, RUN_FILE, starterRunFile, type LaunchSpec, type RunFile, type Task } from '../shared/runConfig'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const folderName = $('folder-name')
const PLACEHOLDER_START = 'Open a folder to start: Ctrl+O, File → Open Folder, or drop a folder here.'
const PLACEHOLDER_FOLDER = 'Pick a file in the tree, Ctrl+P to find one, or Ctrl+N for a new file.'
let rootFolder: string | null = null

/**
 * Closing a file with unsaved changes: Save / Don't Save / Cancel.
 * Returns true if the tab may close now. "Save" saves first and then
 * closes it (so this returns false and closes it once saved).
 */
const workspace: Workspace = new Workspace(window.api, (doc: Doc) => {
  const choice = window.api.askUnsaved(doc.name)
  if (choice === 'discard') return true
  if (choice === 'save') {
    void workspace.save(doc).then(
      () => workspace.close(doc),
      (err) => alert(`Couldn't save ${doc.name}:\n${String(err)}`)
    )
  }
  return false
})
// ---------- editors (one per tab group; two when the view is split) ----------

/** Callbacks for the editor of group `index`. */
const editorOptions = (index: number): EditorOptions => ({
  onEdit: (doc) => {
    workspace.notifyChanged()
    languages.docChanged(doc)
    completion.onEdit()
  },
  onKeyDown: (e) => completion.handleKey(e),
  onType: (text) => completion.onType(text),
  onCtrlClick: (pos) => void goToDefinition(pos),
  onGutterClick: (line) => {
    workspace.focusGroup(index)
    toggleBreakpoint(line)
  },
  onGutterContextMenu: (line) => {
    workspace.focusGroup(index)
    const doc = editors[index].currentDoc
    if (doc) editBreakpoint(doc.path, line)
  },
  onLightbulb: () => {
    workspace.focusGroup(index)
    void codeTools.quickFix()
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
    languages.syncDocs(workspace.docs.filter((d) => !moved.includes(d)))
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
      // No usable trash (common on Linux without a desktop trash service): offer a real delete.
      const reason = String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (!confirm(`Couldn't move ${name} to the trash (${reason}).\n\nDelete it permanently instead? This can't be undone.`)) return false
      try {
        await window.api.deletePermanently(path)
      } catch (err2) {
        alert(`Couldn't delete ${path}:\n${String(err2)}`)
        return false
      }
    }
    workspace.discard(open)
    breakpoints.removeUnder(path)
    void refreshGit()
    return true
  },
  error: (message) => alert(message)
})
export const commands = new CommandRegistry()

// ---------- Welcome page (no files open, or Help → Welcome) ----------

const welcome = new WelcomePage({
  commands,
  folder: () => rootFolder,
  recent: () => window.api.recentList(),
  openRecent: (folder) => void openRecentFolder(folder),
  removeRecent: async (folder) => {
    await window.api.recentRemove(folder)
    refreshRecentSidebar()
  },
  showWhenEmpty: () => userSettings.showWelcome,
  setShowWhenEmpty: (on) => {
    updateUserSettings({ showWelcome: on })
    updateWelcome()
  },
  canClose: () => workspace.docs.length > 0,
  close: () => closeWelcomePage()
})
$('groups').append(welcome.el)
/** Help → Welcome over open files (until a file is picked or it's closed). */
let welcomeForced = false

function updateWelcome(): void {
  const show = welcomeForced || (workspace.docs.length === 0 && userSettings.showWelcome)
  if (show && !welcome.isVisible) {
    welcome.show()
    // Keys mustn't go to a hidden editor behind the page.
    if (editors.some((ed) => ed.hasFocus)) (document.activeElement as HTMLElement | null)?.blur()
  } else if (!show && welcome.isVisible) welcome.hide()
}

function showWelcomePage(): void {
  welcomeForced = true
  updateWelcome()
  welcome.refresh()
}

function closeWelcomePage(): void {
  welcomeForced = false
  updateWelcome()
  if (!welcome.isVisible) editor.focus()
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !welcomeForced || !welcome.isVisible) return
  if (palette.isOpen || settingsView.isOpen) return // Escape closes those first
  closeWelcomePage()
})
const findBar = new FindBar($('editor-pane'), editor)
// ---------- the dock: panels arranged per task (Code, Connect, Debug, Run) ----------
let tasks: TaskController
const dock = new DockView($('dock'), {
  changed: (root) => tasks.changed(root),
  closePanel: (id) => { tasks.closePanel(id); editBar.fill() },
  drop: (p, s, z) => tasks.drop(p, s, z)
})
tasks = new TaskController(dock, {
  saved: {},
  save: (layouts) => void window.api.saveLayouts(layouts).catch(() => {}),
  taskChanged: (t) => onTaskChanged(t)
})
/** The old bottom panel's API, now on the dock (show reveals a panel in the current task). */
const panel = createPanelFacade(tasks, dock)
dock.register({ id: 'editor', title: 'Editor', body: $('editor-pane'), closable: false, onShow: () => { for (const ed of editors) ed.refreshLayout(settings.tabSize) } })
dock.register({ id: 'files', title: 'Files', body: $('file-tree') })
dock.register({ id: 'search', title: 'Search', body: $('search-panel') })
dock.register({ id: 'outline', title: 'Outline', body: $('outline-panel'), onShow: () => void refreshOutline() })
dock.register({ id: 'git', title: 'Git', body: $('git-panel'), onShow: () => void refreshGit() })

/** Edit Layout mode (View → Edit Layout): move, close and add panels; Done or Esc to finish. */
const editBar = new EditBar(document.body, {
  done: () => setEditingLayout(false),
  reset: () => { tasks.resetCurrent(); editBar.fill() },
  add: (id) => tasks.addPanel(id),
  hidden: () => tasks.hiddenPanels(),
  title: (id) => dock.titleOf(id)
})
function setEditingLayout(on: boolean): void {
  if (dock.editing === on) return
  dock.editing = on
  if (on) editBar.show()
  else {
    editBar.hide()
    tasks.flush()
  }
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dock.editing) {
    e.preventDefault()
    e.stopPropagation()
    setEditingLayout(false)
  }
}, true)

/** The task switcher in the top bar shows the current task; the project remembers it. */
function onTaskChanged(task: TaskId): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#task-switcher button')) b.setAttribute('aria-selected', String(b.dataset.task === task))
  if (dock.editing) editBar.fill()
  // Box settings only show while a box is picked (layouts saved before v0.44 placed it for good).
  if (task === 'connect' && !dock.editing) queueMicrotask(closeIdleBoxSettings)
  saveStateSoon()
}

function closeIdleBoxSettings(): void {
  if (tasks.current === 'connect' && !boxes.selected && tasks.isShown('box')) tasks.closePanel('box')
}
const output = new OutputView(
  (path, line) => void openFile(path, line - 1),
  (text) => void window.api.sendRunInput(text),
  { run: () => void runCurrentFile(), stop: () => void window.api.stopRun() }
)
panel.addView('output', 'Output', output.body, output.actions)
const terminal = new TerminalView(
  () => rootFolder,
  (shells, pick) => palette.choose('Shell for the new terminal', shells.map((s) => ({ label: s.name, detail: s.file, run: () => pick(s) }))),
  () => settings.shell
)
panel.addView('terminal', 'Terminal', terminal.body, terminal.actions, () => terminal.show())

// ---------- debugger (debugpy over the Debug Adapter Protocol) ----------

const breakpoints = new BreakpointStore()
/** Docs whose edits we watch so their breakpoints move with the code. */
const watchedDocs = new WeakSet<Doc>()
/** One debugged process: the program (connection 0) or a child process it started. */
interface DebugProcess {
  /** The adapter connection it talks over. */
  id: number
  name: string
  session: DebugSession
  /** Where it's paused (to show again when switching back to it). */
  lastPause: PauseInfo | null
}
let processes: DebugProcess[] = []
/** The program's session: when it ends, debugging ends (with every child process). */
let rootSession: DebugSession | null = null
/** The process shown in the Debug panel: stepping, variables, hover values and the console apply to it. */
let session: DebugSession | null = null
const processOf = (s: DebugSession) => processes.find((p) => p.session === s)
/** Where the paused program is (shown with a ▶ in the gutter and a highlighted line). */
let pausedAt: { path: string; line: number } | null = null
/** What the last debug session ran (for Restart). */
let lastDebugSpec: LaunchSpec | null = null

const debugView = new DebugView({
  continue: () => continueDebugging(),
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
  openLink: (path, line) => void openFile(path, line - 1),
  selectThread: (id) => session ? session.stackTrace(id) : Promise.reject(new Error('Not debugging')),
  selectProcess: (id) => {
    const p = processes.find((x) => x.id === id)
    if (p) showProcess(p)
  },
  watch: (expr, frameId) => session ? session.evaluate(expr, frameId, 'watch') : Promise.reject(new Error('Not debugging')),
  watchesChanged: (list) => {
    watches = list
    saveStateSoon()
  },
  breakpoints: () => breakpoints.save(),
  goToBreakpoint: (b) => void openFile(b.path, b.line),
  setBreakpointEnabled: (b, on) => breakpoints.update(b.path, b.line, { enabled: on }),
  editBreakpoint: (b) => editBreakpoint(b.path, b.line),
  removeBreakpoint: (b) => breakpoints.remove(b.path, b.line),
  setAllBreakpoints: (on) => breakpoints.setAllEnabled(on),
  removeAllBreakpoints: () => breakpoints.clear(),
  exceptionFilters: () => ({ offered: offeredExceptionFilters, on: exceptionFilters }),
  setExceptionFilter: (filter, on) => {
    exceptionFilters = on ? [...new Set([...exceptionFilters, filter])] : exceptionFilters.filter((f) => f !== filter)
    for (const p of processes) void p.session.setExceptionFilters(exceptionFilters).catch(() => {})
    saveStateSoon()
    debugView.renderBreakpoints()
  },
  relative: (p) => (rootFolder && isInside(p, rootFolder) ? p.slice(rootFolder.length).replace(/^[\\/]+/, '') : p)
})
/** Watch expressions and which exceptions pause the program (saved with the project). */
let watches: string[] = []
let exceptionFilters: string[] = ['uncaught']
let offeredExceptionFilters: ExceptionFilter[] = []
debugView.renderBreakpoints()
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
    const styles = new Map(breakpoints.breakpointsFor(doc.path).map((b) => [b.line, breakpointStyle(b)]))
    ed.setLineMarkers(breakpoints.linesFor(doc.path), exec, styles)
  }
}

breakpoints.subscribe((path) => {
  updateLineMarkers()
  debugView.renderBreakpoints()
  saveStateSoon()
  // Breakpoints changed while debugging: tell debugpy right away (in every process).
  for (const p of processes) void p.session.setBreakpoints(path, breakpoints.breakpointsFor(path)).catch(() => {})
})

/** Condition, hit count, log message, on/off for the breakpoint on a line (creating one if needed). */
function editBreakpoint(path: string, line: number): void {
  const b = breakpoints.get(path, line)
  const ask = (what: string, field: 'condition' | 'hitCondition' | 'logMessage', placeholder: string) => () => setTimeout(() =>
    palette.prompt(placeholder, (text) => breakpoints.update(path, line, { [field]: text }), b?.[field] ?? '', `Set ${what}`), 0)
  palette.choose(`Breakpoint on line ${line + 1}${b ? '' : ' (adds one)'}`, [
    { label: 'Condition…', detail: b?.condition ? `now: ${b.condition}` : 'stop only when a Python expression is true, e.g. x > 10', run: ask('condition', 'condition', 'Condition, e.g. x > 10 or name == "Ada" (empty to remove)') },
    { label: 'Hit count…', detail: b?.hitCondition ? `now: ${b.hitCondition}` : 'stop only on some hits, e.g. 3, >= 5, % 2', run: ask('hit count', 'hitCondition', 'Hit count: 3 (the 3rd time), >= 5, % 2 (every 2nd) (empty to remove)') },
    { label: 'Log message instead of stopping…', detail: b?.logMessage ? `now: ${b.logMessage}` : 'print a message, e.g. x is {x}', run: ask('log message', 'logMessage', 'Message to print, {expressions} are filled in, e.g. total = {total} (empty to stop instead)') },
    ...(b ? [
      { label: b.enabled ? 'Switch off' : 'Switch on', run: () => breakpoints.update(path, line, { enabled: !b.enabled }) },
      { label: 'Remove', run: () => breakpoints.remove(path, line) }
    ] : [])
  ])
}

function toggleBreakpoint(line = editor.getCursor().line): void {
  const doc = workspace.active
  if (doc) breakpoints.toggle(doc.path, line)
}

const debugging = () => rootSession?.active === true
const debugPaused = () => session?.state === 'paused'

/** Save every changed file (programs read them from disk). Returns false if one couldn't be saved. */
async function saveAllDirty(report: (message: string) => void): Promise<boolean> {
  for (const doc of workspace.docs.filter((d) => d.dirty)) {
    try {
      await workspace.save(doc)
      languages.didSave(doc)
      if (/\.pyi?$/i.test(doc.path)) projectChangedSoon()
    } catch (err) {
      report(`couldn't save ${doc.name} (${String(err)})`)
      return false
    }
  }
  return true
}

async function startDebugging(given?: LaunchSpec): Promise<void> {
  const resolved = given ?? launchSpec()
  if (rootSession?.active) await stopDebugging()
  tasks.beginDebug(settings.switchToDebugTask)
  panel.show('debug')
  if ('error' in resolved) {
    debugView.begin('')
    debugView.error(resolved.error)
    return
  }
  const spec = resolved
  debugView.begin(describeLaunch(spec))
  if (spec.program && !spec.program.toLowerCase().endsWith('.py')) {
    debugView.error('Debugging works with Python files (.py).')
    return
  }
  // Save every open file first: debugpy reads the files from disk.
  if (!(await saveAllDirty((m) => debugView.error(`Debugging cancelled: ${m}`)))) return
  const cwd = spec.cwd
  debugView.setState('starting')
  const prep = await window.api.debugPrepare(rootFolder ?? cwd, settings.pythonPath || undefined)
  if (!prep.python) {
    debugView.error(settings.pythonPath
      ? `The Python interpreter set in Settings wasn't found:\n  ${settings.pythonPath}\nFix it in Settings (Ctrl+,), or clear it to pick one automatically.`
      : 'Python was not found. Install it from python.org, or pick an interpreter in Settings (Ctrl+,).')
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
      tasks.endDebug()
      statusNote('Debugging cancelled: it needs debugpy (pip install debugpy)')
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
  lastDebugSpec = spec

  processes = []
  debugTrail = new DebugTrail()
  const s = addDebugProcess(0, (spec.program ?? spec.module ?? 'program').split(/[\\/]/).pop() ?? 'program')
  rootSession = s
  session = s
  await window.api.debugStart(prep.python, cwd)
  try {
    if (settings.debugInTerminal) debugView.output('console', 'The program runs in the Terminal tab, so input() works there (Settings → Debug in terminal).\n')
    await s.start({
      program: spec.program, module: spec.module, args: spec.args, env: spec.env, cwd,
      breakpoints: breakpoints.all(),
      exceptionFilters,
      runInTerminal: settings.debugInTerminal
        ? async (a) => {
            const name = (spec.program ?? spec.module ?? 'program').split(/[\\/]/).pop()
            // Start it first: showing an empty terminal panel would open a plain shell too.
            const pid = await terminal.runProgram(`Debug: ${name}`, a.args, a.cwd || cwd, a.env ?? {})
            panel.show('terminal')
            return pid
          }
        : undefined
    })
    offeredExceptionFilters = s.exceptionFilters
    debugView.renderBreakpoints()
  } catch (err) {
    if (rootSession !== s || !s.active) return
    debugView.error(`Couldn't start debugging: ${err instanceof Error ? err.message : String(err)}`)
    await s.stop()
  }
}

/** A session for the program (connection 0) or one of its child processes. */
function addDebugProcess(id: number, name: string): DebugSession {
  const s: DebugSession = new DebugSession({
    send: (m) => window.api.debugSend(id, m),
    onState: (state) => {
      const p = processOf(s)
      if (!p) return
      if (state !== 'paused') p.lastPause = null
      renderProcesses()
      if (session !== s) return
      debugView.setState(state)
      if (state === 'running') graphView.debugRunning()
      if (state === 'running' && pausedAt) {
        pausedAt = null
        updateLineMarkers()
      }
    },
    onOutput: (category, text) => {
      if (processOf(s)) debugView.output(category, text)
    },
    onPaused: (info) => {
      const p = processOf(s)
      if (!p) return
      p.lastPause = info
      // Whichever process stops comes to the front.
      showProcess(p)
    },
    onEnded: (code) => void debugProcessEnded(s, code),
    onChildProcess: (config) => void attachChildProcess(config)
  })
  processes.push({ id, name, session: s, lastPause: null })
  renderProcesses()
  return s
}

/** The program started a child process (multiprocessing, subprocess): debug it too. */
async function attachChildProcess(config: ChildConfig): Promise<void> {
  if (!rootSession?.active) return
  const name = config.subProcessId ? `Process ${config.subProcessId}` : String(config.name ?? 'Child process')
  let id: number
  try {
    id = await window.api.debugConnect(config.connect.host, config.connect.port)
  } catch (err) {
    debugView.error(`Couldn't attach to ${name}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (!rootSession?.active) return
  const s = addDebugProcess(id, name)
  debugView.output('console', `${name} started: debugging it too\n`)
  try {
    await s.attach(config, { breakpoints: breakpoints.all(), exceptionFilters })
  } catch (err) {
    if (!processOf(s) || !s.active) return
    debugView.error(`Couldn't attach to ${name}: ${err instanceof Error ? err.message : String(err)}`)
    await s.stop()
  }
}

async function debugProcessEnded(s: DebugSession, code: number | null): Promise<void> {
  const p = processOf(s)
  if (!p) return
  if (s !== rootSession) {
    processes = processes.filter((x) => x !== p)
    debugView.output('console', `${p.name} ended${code === null ? '' : ` (exit code ${code})`}\n`)
    const root = processes.find((x) => x.session === rootSession)
    if (session === s && root) showProcess(root)
    else renderProcesses()
    return
  }
  // The program ended: stop its child processes too, then the adapter.
  tasks.endDebug()
  graphView.endDebug()
  const children = processes.filter((x) => x !== p)
  processes = []
  session = s
  renderProcesses()
  pausedAt = null
  updateLineMarkers()
  debugView.setState('idle')
  debugView.ended(code)
  await Promise.all(children.map((c) => c.session.stop().catch(() => {})))
  if (rootSession === s) void window.api.debugStop()
}

/** Show a process in the Debug panel (its pause, call stack and variables). */
function showProcess(p: DebugProcess): void {
  session = p.session
  debugView.setState(p.session.state)
  renderProcesses()
  if (p.lastPause && p.session.state === 'paused') {
    void onPaused(p.lastPause)
  } else {
    debugView.clearPaused()
    if (pausedAt) {
      pausedAt = null
      updateLineMarkers()
    }
  }
}

function renderProcesses(): void {
  debugView.setProcesses(
    processes.map((p) => ({ id: p.id, name: p.id === 0 ? `${p.name} (program)` : p.name, state: p.session.state })),
    processes.find((p) => p.session === session)?.id ?? null
  )
}

async function onPaused(info: PauseInfo): Promise<void> {
  debugView.showPaused(info)
  panel.show('debug')
  const frame = debugView.currentFrame
  if (frame) await showFrame(frame)
  void showPauseOnGraph(info)
}

// ---------- the Graph while debugging (5.5) ----------
/** This debug session's pauses: the stacks, the calls seen, each pause's variables. */
let debugTrail = new DebugTrail()

/** Record a pause, and show it on the Graph: the stack, new calls, and the paused function's variables beside it. */
async function showPauseOnGraph(info: PauseInfo): Promise<void> {
  const s = session
  const g = graphView.projectGraph
  const top = info.frames[0]
  if (!s || !g || !rootFolder || !top) return
  const stack = info.frames.map((f) => frameNode(f, g, rootFolder!))
  let vars: Variable[] = []
  try {
    const scopes = await s.scopes(top.id)
    const locals = scopes.find((x) => /local/i.test(x.name)) ?? scopes[0]
    if (locals) vars = await s.variables(locals.ref)
  } catch {
    // running again already
  }
  if (s.state !== 'paused') return
  const stop = debugTrail.addStop({
    reason: info.reason,
    stack,
    vars: Object.fromEntries(vars.filter((v) => !GROUP_ROWS.has(v.name)).map((v) => [v.name, v.value]))
  })
  if (!tasks.isShown('graph')) return
  const at = stop.stack[0] ?? null
  const label = at ? funcLabel(at) : top.name
  const card = at
    ? valueCard({
        title: `${label} · pause #${stop.n}`,
        vars,
        expand: (ref) => s.variables(ref),
        actions: [
          { label: 'Objects', title: 'How the objects in its variables point to each other', run: () => void showObjects(s, top.id, label) },
          { label: 'History', title: 'Its variables at each pause, and compare two pauses', run: () => graphView.reveal(graphView.runView().mode === 'calls' ? at : at.startsWith('module:') ? at.slice(7) : at.slice(0, at.indexOf(':'))) }
        ]
      })
    : null
  graphView.showDebug({ at, stack: stop.stack, newEdges: stop.newEdges, card })
}

/** Object relationships: evaluate Forge's helper in the paused frame and draw what it finds. */
async function showObjects(s: DebugSession, frameId: number, label: string): Promise<void> {
  let text = ''
  try {
    text = (await s.evaluate(objectGraphExpression(), frameId, 'clipboard')).result
  } catch (err) {
    graphView.showOverlay(`Objects in ${label}`, document.createTextNode(`Couldn't look at the objects: ${err instanceof Error ? err.message : String(err)}`))
    return
  }
  const og = parseObjectGraph(text)
  if (!og) return graphView.showOverlay(`Objects in ${label}`, document.createTextNode(`Couldn't read the objects (${text.slice(0, 200)})`))
  if (!og.nodes.length) return graphView.showOverlay(`Objects in ${label}`, document.createTextNode('Its variables only hold simple values (numbers, text...), no objects to draw.'))
  graphView.showOverlay(`Objects in ${label} (variables on the left; arrows are references)`, drawObjectGraph(og))
}

/** Open a stack frame's file at its line and mark it as the paused line. */
async function showFrame(frame: StackFrame): Promise<void> {
  if (!frame.path) return
  pausedAt = { path: frame.path, line: frame.line }
  if (await openFile(frame.path)) editor.goTo(frame.line, frame.col)
  updateLineMarkers()
}

async function stopDebugging(): Promise<void> {
  await rootSession?.stop()
}

/** F5 while paused. In terminal mode the program may be waiting for input there next, so show it. */
function continueDebugging(): void {
  if (!session) return
  void session.continue()
  if (settings.debugInTerminal) panel.show('terminal')
}

async function restartDebugging(): Promise<void> {
  const spec = lastDebugSpec
  await stopDebugging()
  if (spec) await startDebugging(spec)
}

window.api.onDebugMessage((id, m) => processes.find((p) => p.id === id)?.session.handleMessage(m))
window.api.onDebugExit((id, info) => {
  const p = processes.find((x) => x.id === id)
  if (!p?.session.active) return
  if (info.error) debugView.error(info.error)
  p.session.adapterExited()
})

// ---------- Language servers (Pyright for Python; more can run side by side) ----------

/** Every language server the IDE runs, with the settings it's started with for a project. */
const serverSetups: { config: ServerConfig; settings: (root: string) => Promise<Record<string, unknown>> }[] = [
  {
    config: pyright,
    // The interpreter whose packages it should see: the configured one, or the project's venv.
    settings: async (root) => ({ pythonPath: await window.api.resolvePythonForAnalysis(root, settings.pythonPath || undefined) })
  }
]
const lspClients = new Map<string, LspClient>()
const languages = new LanguageServices(serverSetups.map(({ config }) => {
  const client = new LspClient((m) => window.api.lspSend(config.id, m))
  lspClients.set(config.id, client)
  return new LspServer(client, config)
}))
window.api.onLspMessage((id, m) => lspClients.get(id)?.handleMessage(m))
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
    ed.setSquiggles(doc ? languages.diagnosticsFor(doc.path) : [])
  }
  const count = problems.render(languages.allDiagnostics())
  panel.setTitle('problems', count ? `Problems (${count})` : 'Problems')
}
languages.onDiagnostics(showDiagnostics)
const completion = new Completion(editor, languages, () => workspace.active)

/** Crash restarts per server since the folder was opened (to not loop forever). */
const lspRestarts = new Map<string, number>()
async function startLanguageServer(id: string): Promise<void> {
  const setup = serverSetups.find((s) => s.config.id === id)
  const server = languages.server(id)
  if (!rootFolder || !setup || !server) return
  const name = setup.config.name
  lspClients.get(id)?.dispose(`${name} restarting`)
  server.stopped()
  problems.setStatus(`Starting ${name}…`)
  showDiagnostics()
  try {
    await window.api.lspStart(id)
    await server.start(rootFolder, await setup.settings(rootFolder))
    server.syncDocs(workspace.docs.filter((d) => !d.large))
    problems.setStatus('')
    outlineDoc = null
    refreshOutlineSoon(0)
  } catch (err) {
    problems.setStatus(`${name} failed to start: ${String(err)}`)
  }
  showDiagnostics()
}
/** (Re)start every language server, e.g. for a newly opened folder. */
function startLanguageServers(): void {
  lspRestarts.clear()
  for (const { config } of serverSetups) void startLanguageServer(config.id)
}
window.api.onLspExit((id, code) => {
  const setup = serverSetups.find((s) => s.config.id === id)
  if (!setup) return
  lspClients.get(id)?.dispose(`${setup.config.name} stopped`)
  languages.server(id)?.stopped()
  // Restart after an unexpected crash, but don't loop forever.
  const n = lspRestarts.get(id) ?? 0
  lspRestarts.set(id, n + 1)
  if (n < 3) void startLanguageServer(id)
  else {
    problems.setStatus(`${setup.config.name} stopped (exit code ${code}). Reopen the folder to retry.`)
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
  const hits = languages.diagnosticsFor(doc.path).filter((d) => d.severity <= 3 && covers(d, pos))
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
        const md = await languages.hover(doc, pos)
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

/**
 * The cursor, moved onto the name it touches: with the cursor right after
 * a name ("add_tax|("), the language server needs a position inside it.
 */
function cursorOnWord(): { line: number; col: number } {
  const pos = editor.getCursor()
  const line = workspace.active?.buffer.getLine(pos.line) ?? ''
  const word = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
  return !word(line[pos.col]) && word(line[pos.col - 1]) ? { line: pos.line, col: pos.col - 1 } : pos
}

async function goToDefinition(pos = editor.getCursor()): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  hideHover()
  let target
  try {
    target = await languages.definition(doc, pos)
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

// ---------- find references, rename, outline ----------

const hasDocNow = () => workspace.active !== null

/** The name at `pos` in a line (for messages). */
function nameAt(line: string, col: number): string {
  let a = col
  let b = col
  while (a > 0 && /[\p{L}\p{N}_]/u.test(line[a - 1])) a--
  while (b < line.length && /[\p{L}\p{N}_]/u.test(line[b])) b++
  return line.slice(a, b)
}

const referencesView = new ReferencesView(
  (loc) => void openFile(loc.path).then((doc) => {
    if (!doc) return
    editor.select(loc.start, loc.end)
    editor.focus()
  }),
  (path) => (rootFolder && isInside(path, rootFolder) ? path.slice(rootFolder.length).replace(/^[\\/]+/, '') : path)
)
panel.addView('references', 'References', referencesView.body, referencesView.actions)

async function findReferences(): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  panel.show('references')
  if (!languages.knows(doc)) {
    referencesView.message(noLanguageServer(doc, 'Find references'))
    return
  }
  const pos = cursorOnWord()
  const name = nameAt(doc.buffer.getLine(pos.line), pos.col)
  referencesView.message(`Looking for references to "${name}"…`)
  let locations: Location[] = []
  try {
    locations = await languages.references(doc, pos)
  } catch (err) {
    referencesView.message(`Couldn't find references: ${String(err)}`)
    return
  }
  await referencesView.show(name, locations, makeLineReader().line)
}

/** Reads lines of files: open ones from the editor, others once from disk. */
function makeLineReader(): { line: (path: string, line: number) => Promise<string>; all: (path: string) => Promise<readonly string[]> } {
  const cache = new Map<string, Promise<readonly string[]>>()
  const all = (path: string) => {
    const open = workspace.find(path)
    if (open) return Promise.resolve(open.buffer.getLines())
    if (!cache.has(path)) {
      cache.set(path, window.api.readTextFile(path).then((r) => (r.kind === 'text' ? r.text.split(/\r\n|\r|\n/) : []), () => []))
    }
    return cache.get(path)!
  }
  return { all, line: async (path, line) => (await all(path))[line] ?? '' }
}

/** Open a location with its range selected. */
async function showLocation(loc: Location): Promise<void> {
  const doc = await openFile(loc.path)
  if (!doc) return
  editor.select(loc.start, loc.end)
  editor.focus()
}

/**
 * Ctrl+F12, for Python: on a class, the classes that inherit from it; on a
 * method, the subclasses' own versions of it (overrides). Found from the
 * class's references (direct subclasses).
 */
async function findImplementations(followed = false): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  if (!languages.knows(doc)) return statusNote(noLanguageServer(doc, 'Go to Implementations'))
  const pos = cursorOnWord()
  const chain = symbolPathAt(await languages.symbols(doc).catch(() => [] as DocSymbol[]), pos)
  const inner = chain[chain.length - 1]
  const parent = chain[chain.length - 2]
  let cls: DocSymbol | null = null
  let method: string | null = null
  if (inner?.kind === 5 && inner.nameStart.line === pos.line) cls = inner
  else if (inner && [6, 9, 12].includes(inner.kind) && parent?.kind === 5 && inner.nameStart.line === pos.line) {
    cls = parent
    method = inner.name
  }
  if (!cls) {
    // A class or method used here: look from its definition.
    if (!followed) {
      const def = await languages.definition(doc, pos).catch(() => null)
      if (def && (!samePath(def.path, doc.path) || def.start.line !== pos.line)) {
        const target = await openFile(def.path)
        if (target) {
          editor.goTo(def.start.line, def.start.col)
          return findImplementations(true)
        }
      }
    }
    return statusNote('Put the cursor on a class or a method to find its implementations.')
  }
  const what = method ? 'override' : 'subclass'
  const title = method ? `${cls.name}.${method}` : cls.name
  panel.show('references')
  referencesView.message(`Looking for ${method ? `overrides of ${title}` : `subclasses of ${title}`}…`)
  const reader = makeLineReader()
  const refs = await languages.references(doc, cls.nameStart).catch(() => [] as Location[])
  const found: Location[] = []
  for (const ref of refs) {
    const text = await reader.line(ref.path, ref.start.line)
    const sub = subclassAt(text, ref.start.col)
    if (!sub) continue
    if (!method) {
      found.push({ path: ref.path, start: { line: ref.start.line, col: sub.col }, end: { line: ref.start.line, col: sub.col + sub.name.length } })
      continue
    }
    const m = methodInClass(await reader.all(ref.path), ref.start.line, method)
    if (m) found.push({ path: ref.path, start: m, end: { line: m.line, col: m.col + method.length } })
  }
  await referencesView.show(title, found, reader.line, what)
  if (found.length === 1) await showLocation(found[0])
}

async function goToTypeDefinition(): Promise<void> {
  const doc = workspace.active
  if (!doc || !languages.knows(doc)) return
  const locs = await languages.typeDefinition(doc, cursorOnWord()).catch(() => [] as Location[])
  if (!locs.length) return statusNote('No type definition found here.')
  navigationStack.push({ path: doc.path, ...editor.getCursor() })
  await showLocation(locs[0])
}

/** Why `feature` isn't available for this doc: too large, no server for its language, or not started yet. */
function noLanguageServer(doc: Doc, feature: string): string {
  const lang = doc.mode.language
  if (!lang.server) return `${feature} needs a language server, and there isn't one for ${lang.name} files yet.`
  if (doc.large) return 'This file is too large for the language server (it is skipped to stay responsive).'
  const name = serverSetups.find((s) => s.config.id === lang.server)?.config.name ?? 'The language server'
  return `${feature} will work once ${name} has started (it starts when a folder is opened).`
}

/** Ctrl+T: find a class / function anywhere in the project by name. */
function goToProjectSymbol(): void {
  if (!languages.isStarted) {
    palette.choose('No language server is running (open a folder first).', [])
    return
  }
  const rel = (p: string) => (rootFolder && isInside(p, rootFolder) ? p.slice(rootFolder.length).replace(/^[\\/]+/, '') : p)
  palette.search('Go to a class, function or variable anywhere in the project', async (query) => {
    const found = await languages.workspaceSymbols(query).catch(() => [])
    // Project files first (the standard library can match too).
    const inProject = (p: string) => !!rootFolder && isInside(p, rootFolder) && !/[\\/](\.?venv|site-packages)[\\/]/.test(p)
    found.sort((a, b) => Number(inProject(b.location.path)) - Number(inProject(a.location.path)))
    return found.map((s) => ({
      label: s.name,
      detail: `${SYMBOL_KIND[s.kind]?.name ?? 'symbol'}${s.container ? ` in ${s.container}` : ''} · ${rel(s.location.path)}`,
      hint: `line ${s.location.start.line + 1}`,
      run: () => void showLocation(s.location)
    }))
  }, editor.getSelectedText().trim().split('\n')[0] ?? '')
}

const callsView = new CallHierarchyView({
  calls: (item, direction) => languages.calls(item, direction),
  open: (path, pos) => void openFile(path).then((doc) => {
    if (!doc) return
    editor.goTo(pos.line, pos.col)
    editor.focus()
  }),
  relative: (p) => (rootFolder && isInside(p, rootFolder) ? p.slice(rootFolder.length).replace(/^[\\/]+/, '') : p)
})
panel.addView('calls', 'Calls', callsView.body, callsView.actions)

async function showCallHierarchy(): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  panel.show('calls')
  if (!languages.knows(doc)) return callsView.message(noLanguageServer(doc, 'Call hierarchy'))
  const items = await languages.prepareCallHierarchy(doc, cursorOnWord()).catch(() => [])
  if (!items.length) return callsView.message('Put the cursor on a function or method name (its definition or a call to it).')
  callsView.show(items[0])
}

// ---------- other uses of the name under the cursor ----------

let occurrenceTimer: number | undefined
let occurrenceKey = ''
let occurrenceGeneration = 0

function clearOccurrences(): void {
  occurrenceKey = ''
  occurrenceGeneration++
  window.clearTimeout(occurrenceTimer)
  for (const ed of editors) ed.setOccurrences([])
}

/** Called on every cursor move: highlight the other uses of the name under the cursor. */
function updateOccurrences(): void {
  const doc = workspace.active
  if (!doc || !languages.knows(doc) || editor.getSelectedText()) return clearOccurrences()
  const pos = editor.getCursor()
  const line = doc.buffer.getLine(pos.line)
  let start = pos.col
  while (start > 0 && /[\p{L}\p{N}_]/u.test(line[start - 1])) start--
  const name = nameAt(line, pos.col)
  if (!name || /^\d/.test(name)) return clearOccurrences()
  const key = `${doc.path}|${doc.version}|${pos.line}|${start}`
  if (key === occurrenceKey) return
  clearOccurrences()
  occurrenceKey = key
  const gen = occurrenceGeneration
  occurrenceTimer = window.setTimeout(() => {
    void languages.highlights(doc, { line: pos.line, col: start }).then((list) => {
      if (gen !== occurrenceGeneration || workspace.active !== doc) return
      // Just the one under the cursor isn't worth highlighting.
      editor.setOccurrences(list.length > 1 ? list : [])
    }, () => {})
  }, 250)
}

/** Apply edits to an open document as one undoable step. */
function applyEditsToDoc(doc: Doc, edits: TextEdit[]): void {
  const sorted = [...edits].sort((a, b) => b.start.line - a.start.line || b.start.col - a.start.col)
  const before = workspace.active === doc ? editor.getCursor() : { line: 0, col: 0 }
  doc.history.transact('other', before, () => {
    let at = before
    for (const e of sorted) {
      doc.buffer.delete(e.start, e.end)
      at = doc.buffer.insert(e.start, e.text)
    }
    return at
  })
  languages.docChanged(doc)
}

async function renameSymbol(): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  if (!languages.knows(doc)) {
    alert(noLanguageServer(doc, 'Rename'))
    return
  }
  const pos = cursorOnWord()
  let prep: Awaited<ReturnType<typeof languages.prepareRename>> = null
  try {
    prep = await languages.prepareRename(doc, pos)
  } catch { /* treated as "can't rename" */ }
  if (!prep) {
    alert("That can't be renamed. Put the cursor on a name defined in your code (a variable, function, class, parameter...).")
    return
  }
  const oldName = prep.name
  palette.prompt(`Rename "${oldName}" everywhere to…`, (text) => void doRename(doc, pos, oldName, text.trim()), oldName, 'Rename to')
}

async function doRename(doc: Doc, pos: Position, oldName: string, newName: string): Promise<void> {
  if (newName === oldName || !newName) return
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName)) {
    alert(`"${newName}" isn't a valid Python name (letters, digits and _, not starting with a digit).`)
    return
  }
  let edits
  try {
    edits = await languages.rename(doc, pos, newName)
  } catch (err) {
    alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (!edits.size) {
    alert('Nothing to rename.')
    return
  }
  const count = [...edits.values()].reduce((n, l) => n + l.length, 0)
  const closed = [...edits.keys()].filter((p) => !workspace.find(p))
  const rel = (p: string) => (rootFolder && isInside(p, rootFolder) ? p.slice(rootFolder.length).replace(/^[\\/]+/, '') : p)
  if (closed.length) {
    const list = closed.slice(0, 10).map((p) => `  • ${rel(p)}`).join('\n') + (closed.length > 10 ? `\n  …and ${closed.length - 10} more` : '')
    const ok = confirm(
      `Rename "${oldName}" to "${newName}": ${count} change${count === 1 ? '' : 's'} in ${edits.size} file${edits.size === 1 ? '' : 's'}.\n\n` +
      `${closed.length} of them ${closed.length === 1 ? "isn't" : "aren't"} open and will be changed and saved on disk:\n${list}\n\nContinue?`
    )
    if (!ok) return
  }
  // Open files: edited in place (unsaved, Ctrl+Z undoes it).
  for (const [path, list] of edits) {
    const open = workspace.find(path)
    if (open) applyEditsToDoc(open, list)
  }
  // Closed files: changed on disk.
  const failed: string[] = []
  for (const path of closed) {
    try {
      const res = await window.api.readTextFile(path)
      if (res.kind !== 'text') throw new Error('not a text file')
      await window.api.writeTextFile(path, applyEdits(res.text, edits.get(path)!), res.encoding)
    } catch (err) {
      failed.push(`${rel(path)} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  languages.filesChangedOnDisk(closed)
  workspace.notifyChanged()
  if (closed.length) void refreshGit()
  if (failed.length) alert(`These files couldn't be changed, so the rename is incomplete there:\n${failed.join('\n')}`)
}

const outline = new OutlineView((s: DocSymbol) => {
  editor.goTo(s.nameStart.line, s.nameStart.col)
  editor.focus()
})
$('outline-panel').append(outline.root)
let outlineTimer: number | undefined
let outlineGeneration = 0
let outlineDoc: Doc | null = null
let outlineVersion = -1

function refreshOutlineSoon(delay = 500): void {
  window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(() => void refreshOutline(), delay)
}

/** Ask the language server for the open file's symbols (only while the Outline tab shows). */
async function refreshOutline(): Promise<void> {
  if ($('outline-panel').hidden) return
  const doc = workspace.active
  if (!doc) return outline.set([], 'Open a Python file to see its outline.')
  if (!languages.knows(doc)) return outline.set([], noLanguageServer(doc, 'The outline'))
  if (doc === outlineDoc && doc.version === outlineVersion) return
  const gen = ++outlineGeneration
  let symbols: DocSymbol[] = []
  try {
    symbols = await languages.symbols(doc)
  } catch {
    return
  }
  if (gen !== outlineGeneration || workspace.active !== doc) return
  outlineDoc = doc
  outlineVersion = doc.version
  outline.set(symbols)
  outline.highlight(editor.getCursor())
}

/** Ctrl+Shift+O: jump to a class / function / method in this file. */
async function goToSymbol(): Promise<void> {
  const doc = workspace.active
  if (!doc) return
  if (!languages.knows(doc)) {
    palette.choose(noLanguageServer(doc, 'Go to symbol'), [])
    return
  }
  const symbols = await languages.symbols(doc).catch(() => [] as DocSymbol[])
  const items: { label: string; detail?: string; hint?: string; run: () => void }[] = []
  const walk = (list: DocSymbol[], parent: string) => {
    for (const s of list) {
      const kind = SYMBOL_KIND[s.kind]?.name ?? 'symbol'
      items.push({
        label: s.name,
        detail: parent ? `${kind} in ${parent}` : kind,
        hint: `line ${s.nameStart.line + 1}`,
        run: () => {
          editor.goTo(s.nameStart.line, s.nameStart.col)
          editor.focus()
        }
      })
      walk(s.children, parent ? `${parent}.${s.name}` : s.name)
    }
  }
  walk(symbols, '')
  palette.choose(items.length ? 'Go to a symbol in this file' : 'No classes or functions in this file', items)
}

const editorFocused = () => editors.some((e) => e.hasFocus)
commands.register({ id: 'nav.references', title: 'Find All References', keys: 'Shift+F12', when: hasDocNow, run: () => void findReferences() })
commands.register({ id: 'editor.renameSymbol', title: 'Rename Symbol…', keys: 'F2', when: () => hasDocNow() && editorFocused(), run: () => void renameSymbol() })
commands.register({ id: 'nav.symbol', title: 'Go to Symbol in File…', keys: 'Ctrl+Shift+O', when: hasDocNow, run: () => void goToSymbol() })
commands.register({ id: 'view.outline', title: 'Show Outline', run: () => showSidebar('outline') })
commands.register({ id: 'nav.implementations', title: 'Go to Implementations (subclasses / overrides)', keys: 'Ctrl+F12', when: hasDocNow, run: () => void findImplementations() })
commands.register({ id: 'nav.typeDefinition', title: 'Go to Type Definition', when: hasDocNow, run: () => void goToTypeDefinition() })
commands.register({ id: 'nav.projectSymbol', title: 'Go to Symbol in Project…', keys: 'Ctrl+T', when: () => rootFolder !== null, run: goToProjectSymbol })
commands.register({ id: 'nav.callHierarchy', title: 'Show Call Hierarchy', keys: 'Shift+Alt+H', when: hasDocNow, run: () => void showCallHierarchy() })
commands.register({ id: 'panel.calls', title: 'Show Calls Panel', run: () => panel.show('calls') })
commands.register({ id: 'panel.references', title: 'Show References', run: () => panel.show('references') })

// ---------- settings ----------

/** The settings in effect: yours, with the open project's overrides on top. */
let settings: Settings = DEFAULT_SETTINGS
/** Your own settings (settings.json), as shown in the Settings dialog. */
let userSettings: Settings = DEFAULT_SETTINGS
/** What the open project's .forge/settings.json overrides. */
let projectSettings: ProjectSettings = {}
let projectSettingsPath: string | null = null

function applySettings(s: Settings, restartLsp = true): void {
  const pythonChanged = s.pythonPath !== settings.pythonPath
  settings = s
  if (pythonChanged && rootFolder && restartLsp) {
    lspRestarts.delete(pyright.id)
    void startLanguageServer(pyright.id)
    refreshPythonEnv()
  }
  const root = document.documentElement
  root.style.setProperty('--code-size', `${s.fontSize}px`)
  root.style.setProperty('--line-height', `${Math.round(s.fontSize * 1.45)}px`)
  root.style.setProperty('--tab-size', String(s.tabSize))
  root.dataset.theme = s.theme
  for (const ed of editors) ed.refreshLayout(s.tabSize)
  terminal.applyTheme(s.fontSize)
  codeTools.sync(workspace.docs) // Ruff warnings on or off (only called once everything is set up)
}

/** A relative interpreter path in project settings (.venv/bin/python) is relative to the project. */
function resolveInProject(path: string | undefined): string | undefined {
  if (!path || !rootFolder || /^([a-zA-Z]:|[\\/]|~)/.test(path) || !/[\\/]/.test(path)) return path
  const sep = rootFolder.includes('\\') ? '\\' : '/'
  return rootFolder.replace(/[\\/]+$/, '') + sep + path.replace(/^\.[\\/]/, '')
}

const SETTING_NAMES: Record<string, string> = {
  tabSize: 'Tab width', pythonPath: 'Python interpreter', shell: 'Terminal shell',
  formatter: 'Formatter', formatOnSave: 'Format on save', lintWithRuff: 'Ruff warnings'
}

/** Recompute the settings in effect after yours or the project's change. */
function applyEffective(restartLsp = true): void {
  const project = { ...projectSettings }
  if (project.pythonPath !== undefined) project.pythonPath = resolveInProject(project.pythonPath) ?? ''
  applySettings(effectiveSettings(userSettings, project), restartLsp)
  const keys = Object.keys(projectSettings)
  settingsView.setProjectNote(
    keys.length
      ? `This project's .forge/settings.json sets: ${keys.map((k) => SETTING_NAMES[k] ?? k).join(', ')}. ` +
        'Those rows show your own setting; the project\'s value is used while it is open.'
      : rootFolder ? 'A project can set tabSize, pythonPath, shell, formatter, formatOnSave and lintWithRuff in .forge/settings.json (Project Settings below).' : null
  )
}

/** Change your own settings (and save them). */
function updateUserSettings(patch: Partial<Settings>): void {
  userSettings = { ...userSettings, ...patch }
  settingsView.set(userSettings)
  applyEffective()
  void window.api.saveSettings(userSettings)
}

const settingsView = new SettingsView(settings, (s) => {
  userSettings = s
  applyEffective()
  void window.api.saveSettings(s)
})

/** Read <project>/.forge/settings.json (a missing file means no overrides). */
async function loadProjectSettings(folder: string, restartLsp = true): Promise<void> {
  let res
  try {
    res = await window.api.projectSettings(folder)
  } catch {
    return
  }
  if (rootFolder !== folder) return
  projectSettings = res.settings
  projectSettingsPath = res.path
  if (res.error) alert(`This project's settings file couldn't be read, so it's ignored for now:\n${res.path}\n\n${res.error}`)
  applyEffective(restartLsp)
}

// Keep the editor, tabs, tree highlight and window title in sync with the workspace.
let lastActiveDoc: Doc | null = null
workspace.subscribe(() => {
  if (workspace.active !== lastActiveDoc) {
    if (workspace.active) welcomeForced = false // a file was opened or picked
    if (workspace.active) {
      // A file was picked: close the diff over it.
      diffView.hide()
    }
    lastActiveDoc = workspace.active
  }
  updateWelcome()
  refreshOutlineSoon(workspace.active === outlineDoc ? 600 : 50)
  if (gitView.status) refreshBlameSoon(blame?.doc === workspace.active ? 1500 : 150)
  refreshFilePanels()
  syncGroups()
  workspace.groups.forEach((g, i) => {
    tabBars[i].render()
    const ed = editors[i]
    if (g.active !== ed.currentDoc || !g.active) {
      // Only the active side takes keyboard focus.
      if (g.active) ed.show(g.active, i === workspace.activeGroup)
      else ed.showPlaceholder(rootFolder ? PLACEHOLDER_FOLDER : PLACEHOLDER_START)
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
  languages.syncDocs(workspace.docs.filter((d) => !d.large))
  backups.sync(workspace.docs)
  saveStateSoon()
  scheduleStatus()
  showDiagnostics()
  const folder = rootFolder?.split(/[\\/]/).pop()
  document.title = [doc ? (doc.dirty ? '● ' : '') + doc.name : null, folder, 'Forge']
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
  if (settings.formatOnSave && /\.pyi?$/i.test(doc.path)) await codeTools.format({ doc, quiet: true })
  try {
    await workspace.save(doc)
    languages.didSave(doc)
    if (/\.pyi?$/i.test(doc.path)) projectChangedSoon()
    if (shortcuts.path && samePath(doc.path, shortcuts.path)) void shortcuts.load()
    if (rootFolder && projectSettingsPath && samePath(doc.path, projectSettingsPath)) void loadProjectSettings(rootFolder)
    if (rootFolder && runFilePath && samePath(doc.path, runFilePath)) void loadRunFile(rootFolder)
    if (rootFolder && /^(requirements\.txt|pyproject\.toml)$/i.test(doc.name) && samePath(parentDir(doc.path), rootFolder)) refreshPythonEnv()
    if (isTestFile(doc.name) && panel.activeView === 'tests') void tests.discover()
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
  const picked = await window.api.openFolder()
  if (!picked) return // cancelled
  if (typeof picked !== 'string') {
    alert(picked.error)
    return
  }
  await openFolderPath(picked)
}

/** Ask for a folder path to type (or paste) instead of using the dialog. */
function openFolderByPath(): void {
  palette.prompt('Folder to open, e.g. C:\\Users\\me\\project or ~/project', (text) => {
    void window.api.checkFolder(text).then((res) => {
      if (typeof res === 'string') void openFolderPath(res)
      else alert(res.error)
    })
  }, rootFolder ?? '')
}

/** Open a folder that's known to exist, with the tabs and layout it had last time. */
async function openFolderPath(folder: string): Promise<void> {
  saveStateNow() // the project being left
  restoringState = true
  try {
    if (!workspace.closeAll()) return
    rootFolder = folder
    lastRepoSignature = null
    folderName.textContent = folder
    folderName.classList.remove('muted')
    void window.api.recentAdd(folder).catch(() => {})
    // Project files live in .forge/ (older projects have .ideforfun/: moved here first).
    const moved = await window.api.prepareProjectDir(folder).catch(() => 'error' as const)
    if (moved === 'migrated') statusNote('Moved project settings from .ideforfun/ to .forge/')
    else if (moved === 'copied') statusNote("Copied project settings to .forge/ (the old .ideforfun/ folder couldn't be moved)")
    else if (moved === 'error') alert("This project's settings are in .ideforfun/, but Forge couldn't move or copy them to .forge/ (a file may be in use). They aren't used this time: close other programs using the folder and open it again.")
    await loadProjectSettings(folder, false)
    runConfigName = null
    lastTask = null
    tests.reset()
    breakpoints.clear()
    watches = []
    exceptionFilters = ['uncaught']
    debugView.setWatches([])
    await loadRunFile(folder)
    await loadBoxes(folder)
    await tree.setRoot(folder)
    graphView.reset()
    projectGraph = null
    projectGraphFolder = null
    workspace.notifyChanged()
    void refreshGit()
    startLanguageServers()
    refreshPythonEnv()
    await restoreLayout(folder)
  } finally {
    restoringState = false
  }
  welcome.refresh()
  await offerRestore(folder)
}

// ---------- remembering each project's tabs, layout and terminals ----------

let restoringState = false
let stateTimer: number | undefined

function captureState(): WorkspaceState {
  return {
    groups: workspace.groups.map((g, i) => ({
      tabs: g.docs.map((d) => ({ path: d.path, ...(editors[i]?.viewInfo(d) ?? { line: 0, col: 0, scrollTop: 0 }) })),
      active: g.active?.path ?? null
    })),
    activeGroup: workspace.activeGroup,
    terminals: terminal.shellIds(),
    panel: panel.activeView,
    task: tasks.current,
    runConfig: runConfigName,
    breakpoints: breakpoints.save(),
    watches,
    exceptionFilters
  }
}

/** Save the layout a moment after it changes (tabs opened, closed, moved...). */
function saveStateSoon(): void {
  if (!rootFolder || restoringState) return
  window.clearTimeout(stateTimer)
  stateTimer = window.setTimeout(saveStateNow, 1000)
}

function saveStateNow(): void {
  window.clearTimeout(stateTimer)
  if (!rootFolder || restoringState) return
  try {
    window.api.saveWorkspaceState(rootFolder, captureState())
  } catch { /* not worth bothering the user about */ }
}

/** Reopen the tabs, split, cursor positions, terminals and panel the project had last time. */
async function restoreLayout(folder: string): Promise<void> {
  let state: WorkspaceState | null = null
  try {
    state = await window.api.workspaceState(folder)
  } catch { /* unreadable: start fresh */ }
  if (!state || rootFolder !== folder) return
  // Only files inside the project come back (the state could be from a renamed or moved folder).
  const layout = state.groups.map((g) => ({ paths: g.tabs.map((t) => t.path).filter((p) => isInside(p, folder)), active: g.active }))
  await workspace.restore(layout, state.activeGroup)
  // Cursor and scroll position of each tab (preferring the same side it was on).
  workspace.groups.forEach((g, i) => {
    for (const doc of g.docs) {
      const tab = state.groups[i]?.tabs.find((t) => samePath(t.path, doc.path)) ??
        state.groups.flatMap((sg) => sg.tabs).find((t) => samePath(t.path, doc.path))
      if (tab) editors[i]?.restoreView(doc, tab)
    }
  })
  if (state.runConfig && runFile.configurations.some((c) => c.name === state.runConfig)) runConfigName = state.runConfig
  breakpoints.load(state.breakpoints.filter((b) => isInside(b.path, folder)))
  watches = state.watches
  exceptionFilters = state.exceptionFilters ?? ['uncaught']
  debugView.setWatches(watches)
  debugView.renderBreakpoints()
  scheduleStatus()
  terminal.setPending(state.terminals)
  tasks.switchTo(state.task)
  if (state.panel) panel.show(state.panel)
}

// ---------- recent folders ----------

/** Open a folder from the recent list; offer to forget it if it's gone. */
async function openRecentFolder(folder: string): Promise<void> {
  const res = await window.api.checkFolder(folder)
  if (typeof res === 'string') return openFolderPath(res)
  if (confirm(`${res.error}\n\nRemove it from the recent folders?`)) {
    await window.api.recentRemove(folder)
    refreshRecentSidebar()
  }
}

const folderLabel = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

function showRecentPicker(): void {
  void window.api.recentList().then((list) => {
    palette.choose(list.length ? 'Open a recent folder' : 'No recent folders yet', list.map((folder) => ({
      label: folderLabel(folder),
      detail: folder,
      run: () => void openRecentFolder(folder)
    })))
  })
}

/** With no folder open, the sidebar lists recent folders. */
function refreshRecentSidebar(): void {
  welcome.refresh()
  if (rootFolder) return
  void window.api.recentList().then((list) => tree.showRecent(list, (f) => void openRecentFolder(f))).catch(() => {})
}

window.api.onMenuOpenRecent((folder) => void openRecentFolder(folder))

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
    `Forge didn't close properly last time, and ${found.length} file${found.length > 1 ? 's had' : ' had'} unsaved changes:\n\n${list}\n\n` +
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
    languages.docChanged(doc)
  }
  workspace.notifyChanged()
}

// ---------- commands ----------

const hasDoc = () => workspace.active !== null

commands.register({ id: 'file.openFolder', title: 'Open Folder…', keys: 'Ctrl+O', run: openFolder })
commands.register({ id: 'editor.toggleComment', title: 'Toggle Comment', when: hasDoc, run: () => editor.toggleComment() })

// Menu bar: commands by id, and Edit actions for the editor or whatever text box has focus.
window.api.onMenuCommand((id) => commands.run(id))
window.api.onMenuEdit((action) => {
  const ed = editors.find((e) => e.hasFocus)
  if (!ed || action === 'paste') return window.api.nativeEdit(action) // paste arrives in the editor as a normal paste
  ed[action]()
})
commands.register({ id: 'file.openFolderByPath', title: 'Open Folder by Path…', run: openFolderByPath })
commands.register({ id: 'file.openRecent', title: 'Open Recent Folder…', keys: 'Ctrl+R', run: showRecentPicker })
commands.register({
  id: 'file.clearRecent', title: 'Clear Recent Folders',
  run: async () => {
    await window.api.recentClear()
    refreshRecentSidebar()
  }
})

// Drop a folder (or a file) onto the window to open it.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})
window.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files[0]
  if (!file) return
  e.preventDefault()
  const path = window.api.pathForFile(file)
  if (!path) return
  void window.api.checkFolder(path).then((res) => {
    if (typeof res === 'string') void openFolderPath(res)
    else void openFile(path) // not a folder: open it as a file
  })
})
commands.register({ id: 'file.save', title: 'Save', keys: 'Ctrl+S', when: hasDoc, run: () => void saveActive() })
const hasFolder = () => rootFolder !== null
/** New items go next to the open file, or wherever is selected in the tree. */
const newItem = (isDirectory: boolean) => {
  showSidebar('files')
  void tree.startCreate(isDirectory)
}
/** New File with no folder open: choose where to save it, then open it. */
async function newFileAnywhere(): Promise<void> {
  const res = await window.api.newFileDialog()
  if (!res) return
  if (typeof res !== 'string') return alert(res.error)
  await openFile(res)
}

/** New Folder with no folder open: make a project folder somewhere and open it. */
async function newProjectFolder(): Promise<void> {
  const parent = await window.api.pickParentFolder()
  if (!parent) return
  if (typeof parent !== 'string') return alert(parent.error)
  palette.prompt(`Name of the new folder (inside ${parent})`, (name) => {
    void window.api.createEntry(parent, name, true).then(
      (path) => openFolderPath(path),
      (err) => alert(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    )
  }, '', 'Create')
}

commands.register({ id: 'file.new', title: 'New File…', keys: 'Ctrl+N', run: () => (hasFolder() ? newItem(false) : void newFileAnywhere()) })
commands.register({ id: 'file.newFolder', title: 'New Folder…', run: () => (hasFolder() ? newItem(true) : void newProjectFolder()) })
commands.register({ id: 'help.welcome', title: 'Welcome', run: () => (welcome.isVisible && welcomeForced ? closeWelcomePage() : showWelcomePage()) })
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
commands.register({ id: 'tab.next', title: 'Next Tab', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], when: hasDoc, run: () => workspace.next(1) })
commands.register({ id: 'tab.prev', title: 'Previous Tab', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], when: hasDoc, run: () => workspace.next(-1) })

commands.register({ id: 'find.open', title: 'Find', keys: 'Ctrl+F', when: hasDoc, run: () => findBar.open(false) })
commands.register({ id: 'find.replace', title: 'Find and Replace', keys: 'Ctrl+H', when: hasDoc, run: () => findBar.open(true) })
commands.register({ id: 'find.close', title: 'Close Find', keys: 'Escape', when: () => findBar.isOpen, run: () => findBar.close() })

// ---------- running Python ----------

const parentDir = (path: string) => path.replace(/[\\/][^\\/]*$/, '')
let lastRunId = 0

/** Run the selected run configuration, or the open file (Ctrl+F5). */
async function runCurrentFile(): Promise<void> {
  panel.show('output')
  const spec = launchSpec()
  if ('error' in spec) {
    output.clear()
    output.error(spec.error)
    return
  }
  output.begin(describeLaunch(spec))
  if (spec.program && !spec.program.toLowerCase().endsWith('.py')) {
    output.error('Run works with Python files (.py). To run something else, add a task (Run Task… → Configure).')
    return
  }
  // Auto-save before running, so Python sees what's in the editor.
  if (!(await saveAllDirty((m) => output.error(`Run cancelled: ${m}`)))) return
  // With the Graph in view (and the setting on), the run shows where it's at on it.
  // With the Network panel in view, the run reports its web requests there too.
  const trace = (settings.showRunsOnGraph && tasks.isShown('graph')) || tasks.isShown('network')
  await window.api.runPython({ ...spec, root: rootFolder ?? spec.cwd, python: settings.pythonPath || undefined, trace })
  editor.focus()
}

// ---------- run configurations and tasks (.forge/run.json) ----------

let runFile: RunFile = { configurations: [], tasks: [] }
let runFilePath: string | null = null
/** The configuration Run and Debug use; null = the open file. */
let runConfigName: string | null = null
let lastTask: Task | null = null

const selectedConfig = () => runFile.configurations.find((c) => c.name === runConfigName) ?? null

/** What Run / Debug start: the selected configuration, or the open file. */
function launchSpec(): LaunchSpec | { error: string } {
  const file = workspace.active?.path ?? null
  const cfg = selectedConfig()
  if (cfg && rootFolder) return resolveConfiguration(cfg, { project: rootFolder, file })
  if (!file) return { error: rootFolder ? 'Open a Python file first (pick one in the tree, or Ctrl+P), or pick a run configuration.' : 'Open a folder (Ctrl+O) and a Python file first.' }
  return { program: file, module: null, args: [], env: {}, cwd: rootFolder ?? parentDir(file) }
}

/** "app.py --port 8000" or "-m flask run", for the Output / Debug headers. */
function describeLaunch(spec: LaunchSpec): string {
  const quote = (a: string) => (/[\s"]/.test(a) || a === '' ? JSON.stringify(a) : a)
  const what = spec.program ?? `-m ${spec.module}`
  const cfg = selectedConfig()
  return [cfg ? `[${cfg.name}]` : '', what, ...spec.args.map(quote)].filter(Boolean).join(' ')
}

/** Can Run / Debug start something right now? */
const canLaunch = () => hasDoc() || selectedConfig() !== null

async function loadRunFile(folder: string): Promise<void> {
  try {
    const res = await window.api.readProjectFile(folder, RUN_FILE)
    if (rootFolder !== folder) return
    runFile = normalizeRunFile(res.value)
    runFilePath = res.path
    if (res.error) alert(`The project's run configurations couldn't be read, so none are used for now:\n${res.path}\n\n${res.error}`)
  } catch {
    runFile = { configurations: [], tasks: [] }
  }
  if (runConfigName && !selectedConfig()) runConfigName = null
  scheduleStatus()
}

/** Open run.json, creating it with examples first if needed. */
async function editRunFile(): Promise<void> {
  if (!rootFolder) return
  const folder = rootFolder
  try {
    const files = await window.api.listFiles(folder).catch(() => [])
    const hasRequirements = files.some((f) => f.rel === 'requirements.txt')
    const path = await window.api.ensureProjectFile(folder, RUN_FILE, starterRunFile(hasRequirements))
    await tree.refreshAll()
    await openFile(path)
    await loadRunFile(folder)
  } catch (err) {
    alert(`Couldn't create the run configurations file: ${String(err)}`)
  }
}

function pickRunConfig(): void {
  const items = [
    { label: 'Current file', detail: 'run whichever Python file is open', hint: runConfigName === null ? '✓' : undefined, run: () => setRunConfig(null) },
    ...runFile.configurations.map((c) => ({
      label: c.name,
      detail: [c.module ? `-m ${c.module}` : c.file ?? '${file}', ...c.args].join(' '),
      hint: c.name === runConfigName ? '✓' : undefined,
      run: () => setRunConfig(c.name)
    })),
    { label: runFile.configurations.length ? 'Edit run configurations…' : 'Add a run configuration…', detail: '.forge/run.json', run: () => void editRunFile() }
  ]
  palette.choose('Run configuration for F5 / Ctrl+F5', items)
}

function setRunConfig(name: string | null): void {
  runConfigName = name
  scheduleStatus()
  saveStateSoon()
}

function runTask(task: Task): void {
  if (!rootFolder) return
  const res = resolveTask(task, { project: rootFolder, file: workspace.active?.path ?? null })
  if ('error' in res) return alert(res.error)
  lastTask = task
  panel.show('terminal')
  void terminal.runCommand(task.name, res.command, res.cwd)
}

function pickTask(): void {
  const items = [
    ...runFile.tasks.map((t) => ({ label: t.name, detail: t.command, run: () => runTask(t) })),
    { label: runFile.tasks.length ? 'Edit tasks…' : 'Add a task…', detail: '.forge/run.json', run: () => void editRunFile() }
  ]
  palette.choose(runFile.tasks.length ? 'Run a task (in a new terminal)' : 'No tasks yet: add some to .forge/run.json', items)
}

/** What to do when a tool run (pip, venv) ends, by run id. */
const afterRun = new Map<number, (code: number | null) => void>()
let lastExit: { runId: number; code: number | null } | null = null

// ---------- live run feedback (a traced run's updates) ----------
/** Boxes whose function is running (lit like during a Test call). */
const runBoxes = new Set<string>()
/** Requests already sparked on the Graph (a record is re-sent as its body arrives). */
const sparkedNet = new Set<number>()
window.api.onRunTrace((e) => {
  if (e.runId < lastRunId) return
  if ((e.message as { t?: unknown } | null)?.t === 'hello') {
    netLog.begin(e.runId)
    sparkedNet.clear()
    networkView.setRunning(true)
    recursion.begin(e.runId)
    replayTicks = []
    graphView.setReplay(0, () => {}, () => {})
    return
  }
  const rec = parseRec(e.message)
  if (rec) {
    if (recursion.runId === e.runId) {
      recursion.add(rec)
      recursionChanged()
    }
    return
  }
  const net = parseNet(e.message)
  if (net) {
    if (netLog.runId !== e.runId) return
    netLog.upsert(net)
    networkView.update()
    if (stateOf(net) !== 'pending' && !sparkedNet.has(net.id) && settings.showRunsOnGraph && tasks.isShown('graph')) {
      sparkedNet.add(net.id)
      const spark = planNetSpark(net, graphView.runView(), boxes.boxes)
      if (spark) graphView.showNet(spark)
    }
    return
  }
  const tick = parseTrace(e.message)
  if (tick === 'end') {
    endRunOnGraph()
    offerReplay()
    return
  }
  if (!tick) return
  if (replayTicks.length < 6000) replayTicks.push(tick)
  const frame = planFrame(tick, graphView.runView(), boxes.boxes)
  graphView.showRun(frame)
  const lit = new Set(frame.boxes)
  if (lit.size !== runBoxes.size || [...lit].some((id) => !runBoxes.has(id))) {
    runBoxes.clear()
    for (const id of lit) runBoxes.add(id)
    graphView.redrawBoxes()
  }
})
/** The last traced run's updates, to replay on the graph. */
let replayTicks: TraceTick[] = []
function offerReplay(): void {
  const ticks = replayTicks
  graphView.setReplay(ticks.length, (i) => graphView.showRun(planFrame(ticks[i], graphView.runView(), boxes.boxes)), () => graphView.endRun())
}

/** The last traced run's recursion trees (shown in a function's details on the Graph). */
const recursion = new RecursionStore()
let recursionRedraw = 0
function recursionChanged(): void {
  // Trees update many times a second while the program recurses: redraw the details at most twice a second.
  if (recursionRedraw) return
  recursionRedraw = window.setTimeout(() => {
    recursionRedraw = 0
    graphView.refreshSide()
  }, 500)
}

/** A node's recursion trees from the last run: a line per tree, which opens its drawing. */
function recursionDetails(node: string): HTMLElement | null {
  const funcs = node.includes(':') ? [node] : recursion.funcs().filter((f) => f.slice(0, f.indexOf(':')) === node)
  const trees = funcs.flatMap((f) => recursion.forFunc(f))
  if (!trees.length) return null
  const box = document.createElement('div')
  box.className = 'graph-run-details'
  for (const t of trees) {
    const name = t.func.slice(t.func.indexOf(':') + 1).split('.').pop() ?? t.func
    const b = document.createElement('button')
    b.className = 'graph-button'
    const depth = t.nodes.reduce((d, n, i, all) => {
      let k = 0
      for (let j = i; all[j].parent >= 0; j = all[j].parent) k++
      return Math.max(d, k + 1)
    }, 0)
    b.textContent = `Recursion tree: ${name}(${t.nodes[0].args}), ${t.total} calls, ${depth} deep`
    b.title = t.total > t.nodes.length ? `Shows the first ${t.nodes.length} calls` : 'Every call, with its arguments and what it returned'
    b.addEventListener('click', () => graphView.showOverlay(`Recursion: ${name}(${t.nodes[0].args})${t.total > t.nodes.length ? ` (first ${t.nodes.length} of ${t.total} calls)` : ''}`, drawRecursionTree(t, name)))
    box.append(b)
  }
  return box
}

function endRunOnGraph(): void {
  graphView.endRun()
  networkView.setRunning(false)
  if (runBoxes.size) {
    runBoxes.clear()
    graphView.redrawBoxes()
  }
}

window.api.onRunEvent((e) => {
  if (e.runId < lastRunId) return // late event from a run we already replaced
  lastRunId = e.runId
  if (e.type !== 'output') scheduleStatus() // the ▶ Run / ■ Stop button
  if (e.type === 'exit') endRunOnGraph()
  if (e.type === 'start') output.started(e.python)
  else if (e.type === 'output') output.append(e.stream, e.text)
  else if (e.type === 'error') output.error(e.message)
  else if (e.type === 'exit') {
    output.finished(e.code, e.ms, e.signal)
    lastExit = { runId: e.runId, code: e.code }
    const after = afterRun.get(e.runId)
    afterRun.delete(e.runId)
    after?.(e.code)
  }
})

/** Run python -m pip / venv in the Output panel (in the project folder). */
async function runTool(title: string, tool: PythonTool, after?: (code: number | null) => void): Promise<void> {
  if (!rootFolder) return
  panel.show('output')
  output.begin(title)
  const id = await window.api.runPython({ root: rootFolder, program: null, module: tool.module, args: tool.args, env: {}, cwd: rootFolder, python: tool.python })
  if (!after) return
  // A run that fails to start may have ended before we got its id.
  if (lastExit?.runId === id) after(lastExit.code)
  else afterRun.set(id, after)
}

commands.register({
  id: 'run.smart', title: 'Run (or Debug if there are breakpoints) / Continue', keys: 'F5',
  when: () => canLaunch() || debugPaused(),
  run: () => {
    if (debugPaused()) return continueDebugging()
    if (debugging()) return // starting or running: nothing to do
    if (breakpoints.count > 0) return void startDebugging()
    void runCurrentFile()
  }
})
commands.register({ id: 'run.file', title: 'Run Python File (without debugging)', keys: 'Ctrl+F5', when: canLaunch, run: runCurrentFile })
commands.register({ id: 'run.selectConfig', title: 'Select Run Configuration…', when: () => rootFolder !== null, run: pickRunConfig })
commands.register({ id: 'run.editConfigs', title: 'Edit Run Configurations and Tasks (run.json)', when: () => rootFolder !== null, run: () => void editRunFile() })
commands.register({ id: 'tasks.run', title: 'Run Task…', keys: 'Ctrl+Shift+B', when: () => rootFolder !== null, run: pickTask })
commands.register({ id: 'tasks.rerun', title: 'Run Last Task Again', when: () => lastTask !== null && rootFolder !== null, run: () => runTask(lastTask!) })
commands.register({
  id: 'run.stop', title: 'Stop Running / Debugging', keys: 'Shift+F5',
  run: () => {
    if (debugging()) void stopDebugging()
    else if (output.isRunning) {
      void window.api.stopRun()
      output.discardWaiting()
    } else if (output.hasWaiting) output.discardWaiting() // the program ended but its output is still being shown
    else {
      panel.show('output')
      output.error('Nothing is running.')
    }
  }
})
commands.register({ id: 'debug.start', title: 'Start Debugging', when: () => canLaunch() && !debugging(), run: () => void startDebugging() })
commands.register({ id: 'debug.restart', title: 'Restart Debugging', keys: 'Ctrl+Shift+F5', when: debugging, run: () => void restartDebugging() })
commands.register({ id: 'debug.stepOver', title: 'Step Over', keys: 'F10', when: debugPaused, run: () => void session!.stepOver() })
commands.register({ id: 'debug.stepInto', title: 'Step Into', keys: 'F11', when: debugPaused, run: () => void session!.stepInto() })
commands.register({ id: 'debug.stepOut', title: 'Step Out', keys: 'Shift+F11', when: debugPaused, run: () => void session!.stepOut() })
commands.register({ id: 'debug.pause', title: 'Pause', when: () => session?.state === 'running', run: () => void session!.pause() })
commands.register({ id: 'debug.toggleBreakpoint', title: 'Toggle Breakpoint', keys: 'F9', when: hasDoc, run: () => toggleBreakpoint() })
commands.register({
  id: 'debug.editBreakpoint', title: 'Edit Breakpoint (condition, hit count, log message)…', when: hasDocNow,
  run: () => editBreakpoint(workspace.active!.path, editor.getCursor().line)
})
commands.register({
  id: 'debug.toggleRaised', title: 'Debug: Pause on Raised Exceptions (on / off)',
  run: () => {
    const on = !exceptionFilters.includes('raised')
    exceptionFilters = on ? [...exceptionFilters, 'raised'] : exceptionFilters.filter((f) => f !== 'raised')
    for (const p of processes) void p.session.setExceptionFilters(exceptionFilters).catch(() => {})
    statusNote(on ? 'The debugger now pauses wherever an exception is raised.' : 'The debugger pauses only on uncaught exceptions.')
    saveStateSoon()
    debugView.renderBreakpoints()
  }
})
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
commands.register({ id: 'nav.definition', title: 'Go to Definition', keys: 'F12', when: hasDoc, run: () => void goToDefinition(cursorOnWord()) })
commands.register({ id: 'nav.back', title: 'Go Back', keys: 'Alt+ArrowLeft', run: () => void goBack() })
commands.register({ id: 'panel.problems', title: 'Show Problems', keys: 'Ctrl+Shift+M', run: () => panel.show('problems') })
commands.register({ id: 'python.restartServer', title: 'Restart Python Language Server', when: () => rootFolder !== null, run: () => { lspRestarts.delete(pyright.id); void startLanguageServer(pyright.id) } })
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
  run: () => updateUserSettings({ fontSize: Math.min(28, userSettings.fontSize + 1) })
})
commands.register({
  id: 'view.zoomOut', title: 'Decrease Font Size', keys: 'Ctrl+-',
  run: () => updateUserSettings({ fontSize: Math.max(10, userSettings.fontSize - 1) })
})
commands.register({
  id: 'view.toggleTheme', title: 'Toggle Plain Theme',
  run: () => updateUserSettings({ theme: userSettings.theme === 'molten' ? 'plain' : 'molten' })
})
commands.register({
  id: 'settings.project', title: 'Open Project Settings', when: () => rootFolder !== null,
  run: async () => {
    const folder = rootFolder!
    try {
      const path = await window.api.ensureProjectSettings(folder, {})
      await tree.refreshAll()
      await openFile(path)
      await loadProjectSettings(folder)
    } catch (err) {
      alert(`Couldn't create the project settings file: ${String(err)}`)
    }
  }
})

// ---------- git status in the file tree ----------

let gitBusy = false
/** What the repository looked like at the last check (null = not checked yet in this folder). */
let lastRepoSignature: string | null = null

async function refreshGit(): Promise<void> {
  if (!rootFolder || gitBusy) return
  gitBusy = true
  const folder = rootFolder
  try {
    const [status, repo] = await Promise.all([window.api.gitStatus(folder), window.api.gitRepo(folder)])
    if (rootFolder !== folder) return
    tree.setGitStatus(status)
    const hadRepo = gitView.status !== null
    // Commits, merges, pulls or checkouts done outside the IDE (e.g. in the terminal) change
    // files on disk: reload the open files that have no unsaved edits.
    const signature = repo ? JSON.stringify([repo.head, repo.branch, repo.staged, repo.unstaged, repo.conflicts]) : ''
    if (lastRepoSignature !== null && signature !== lastRepoSignature) void reloadCleanDocs()
    lastRepoSignature = signature
    gitView.setStatus(repo)
    if (repo && !hadRepo) refreshBlameSoon(0)
    const branch = $('sb-branch')
    branch.textContent = repo ? `⎇ ${repo.detached ? 'detached' : repo.branch ?? ''}${repo.ahead ? ` ↑${repo.ahead}` : ''}${repo.behind ? ` ↓${repo.behind}` : ''}` : ''
    // The diff on screen may be out of date (files edited, staged elsewhere...).
    if (diffView.isVisible) void diffView.reload()
  } finally {
    gitBusy = false
  }
}
// Pick up changes made outside the editor (terminal, other apps): on focus and every few seconds.
window.addEventListener('focus', () => void refreshGit())
window.setInterval(() => {
  if (document.hasFocus()) void refreshGit()
}, 5000)

// ---------- Source Control (git) ----------

/**
 * Files changed on disk by git (switch branch, pull, discard): reload the open
 * ones that have no unsaved changes, changing only the lines that differ.
 */
async function reloadCleanDocs(): Promise<void> {
  for (const doc of workspace.docs) {
    if (doc.dirty) continue
    const res = await window.api.readTextFile(doc.path).catch(() => null)
    if (!res || res.kind !== 'text' || doc.dirty) continue
    const now = doc.buffer.getLines().join('\n')
    const disk = res.text.replace(/\r\n?/g, '\n')
    const edit = lineDiff(now, disk)
    if (!edit) continue
    applyEditsToDoc(doc, [edit])
    doc.eol = res.text.includes('\r\n') ? 'CRLF' : 'LF'
    doc.markSaved()
  }
  workspace.notifyChanged()
}

/** Run a git action from the Git or diff view: show progress and errors, then refresh. */
async function gitRun(action: () => Promise<{ ok: boolean; error?: string; output: string }>, busyText: string): Promise<boolean> {
  gitView.setBusy(busyText)
  let res: { ok: boolean; error?: string; output: string }
  try {
    res = await action()
  } catch (err) {
    res = { ok: false, output: '', error: String(err) }
  }
  gitView.setBusy('')
  if (!res.ok) alert(`Git: ${res.error ?? 'it failed'}`)
  else if (/Pull|Fetch|Push/.test(busyText) && res.output) statusNote(res.output.split('\n').filter(Boolean).pop() ?? '')
  // Switching, pulling and discarding change files on disk.
  if (res.ok && /Switch|Pull|Discard|Creat/.test(busyText)) await reloadCleanDocs()
  await refreshGit()
  void tree.refreshAll()
  blame = null // commits change who-wrote-what
  refreshBlameSoon(0)
  conflictBarKey = ''
  return res.ok
}

const gitView = new GitView({
  folder: () => rootFolder,
  openDiff: (repo, change, staged) => void diffView.show(repo, change, staged),
  openFile: (path) => void openFile(path),
  run: gitRun,
  trash: async (paths) => {
    for (const p of paths) {
      try {
        await window.api.trashEntry(p)
      } catch {
        await window.api.deletePermanently(p)
      }
    }
  },
  pickBranch: () => void pickBranch(),
  refresh: () => void refreshGit()
})
$('git-panel').append(gitView.root)

const diffView = new DiffView({
  openFile: (path, line) => void openFile(path, line).then(() => diffView.hide()),
  run: gitRun,
  closed: () => editor.focus()
})
$('groups').append(diffView.el)

// ---------- Project Graph (how the project fits together) ----------

// One analysis of the project, shared by the Graph, Where you are and In this file panels.
let projectGraph: ProjectGraph | null = null
let projectGraphFolder: string | null = null
let projectScan: Promise<{ graph?: ProjectGraph; error?: string }> | null = null
/** The folder whose last analysis failed (not retried automatically). */
let scanFailedFor: string | null = null
function scanProjectGraph(): Promise<{ graph?: ProjectGraph; error?: string }> {
  if (!rootFolder) return Promise.resolve({ error: 'Open a folder first.' })
  if (projectScan) return projectScan
  const folder = rootFolder
  projectScan = window.api.scanProject(folder, settings.pythonPath || undefined)
    .catch((err) => ({ error: String(err), scan: undefined }))
    .then((res) => {
      projectScan = null
      if (rootFolder !== folder) return { error: 'The folder changed.' }
      if (!res.scan) {
        // Not retried on its own (the Graph's ⟳ or a save tries again).
        scanFailedFor = folder
        refreshFilePanels()
        return { error: res.error ?? 'no result' }
      }
      scanFailedFor = null
      projectGraph = buildGraph(res.scan)
      projectGraphFolder = folder
      refreshFilePanels()
      return { graph: projectGraph }
    })
  return projectScan
}
let rescanTimer: number | undefined
/** A Python file was saved: analyse again soon, if a panel showing the analysis is open. */
function projectChangedSoon(): void {
  window.clearTimeout(rescanTimer)
  rescanTimer = window.setTimeout(() => {
    scanFailedFor = null
    if (tasks.isShown('where') || tasks.isShown('infile') || tasks.isShown('graph')) void scanProjectGraph().then(() => { if (tasks.isShown('graph')) void graphView.refresh() })
  }, 1500)
}

const whereView = new WhereView({
  open: (module) => {
    const m = projectGraph?.modules.find((x) => x.id === module)
    if (m && rootFolder) void openFile(projectPath(m.path))
  },
  reveal: (module) => {
    tasks.reveal('graph')
    graphView.revealModule(module)
  }
})
const inFileView = new InFileView((line) => {
  editor.goTo(line)
  editor.focus()
})
dock.register({ id: 'where', title: 'Where you are', body: whereView.body, onShow: () => showFilePanels() })
dock.register({ id: 'infile', title: 'In this file', body: inFileView.body, onShow: () => showFilePanels() })

/** An absolute path for a project-relative one. */
function projectPath(rel: string): string {
  const folder = rootFolder ?? ''
  const sep = folder.includes('\\') ? '\\' : '/'
  return folder.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
}

/** The panels became visible: analyse the project first if needed. */
function showFilePanels(): void {
  if (rootFolder && projectGraphFolder !== rootFolder) void scanProjectGraph()
  refreshFilePanels()
}

/** Update Where you are and In this file for the active file. */
function refreshFilePanels(): void {
  if (!tasks.isShown('where') && !tasks.isShown('infile')) return
  if (rootFolder && projectGraphFolder !== rootFolder && !projectScan && scanFailedFor !== rootFolder) void scanProjectGraph()
  const doc = workspace.active
  let module: string | null = null
  let message = 'Open a Python file to see where it fits.'
  if (!rootFolder) message = 'Open a folder first.'
  else if (doc && /\.pyi?$/i.test(doc.path)) {
    if (!projectGraph || projectGraphFolder !== rootFolder) message = scanFailedFor === rootFolder ? "Couldn't analyse the project (see the Graph in Connect for why)." : 'Analysing the project…'
    else if (!isInside(doc.path, rootFolder)) message = 'This file is outside the project.'
    else {
      module = moduleForPath(projectGraph, doc.path.slice(rootFolder.length).replace(/^[\\/]+/, ''))
      if (!module) message = 'This file was not part of the last analysis (save it to update).'
    }
  }
  whereView.set(module ? projectGraph : null, module, message)
  inFileView.set(module ? projectGraph : null, module, message)
}

// ---------- Connect: boxes (.forge/boxes.json) ----------

/** Boxes whose test call is running (their wire is live on the Graph). */
const liveBoxes = new Set<string>()

/** The absolute path for a path a box writes to, which must stay inside the project. */
function boxPath(rel: string): string {
  if (!rootFolder) throw new Error('Open a folder first.')
  const clean = rel.replace(/\\/g, '/')
  if (/^([a-z]:)?\//i.test(clean) || clean.split('/').includes('..')) throw new Error(`"${rel}" must be a path inside the project (like api/github.py).`)
  return projectPath(clean)
}

/** One edit that turns `from` into `to` (only the part that changed). */
function textChange(from: string, to: string): TextEdit {
  let start = 0
  while (start < from.length && start < to.length && from[start] === to[start]) start++
  let end = 0
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++
  const pos = (offset: number) => {
    const before = from.slice(0, offset)
    const line = before.split('\n').length - 1
    return { line, col: offset - (before.lastIndexOf('\n') + 1) }
  }
  return { start: pos(start), end: pos(from.length - end), text: to.slice(start, to.length - end) }
}

const boxFiles: BoxFiles = {
  read: async (rel) => {
    const path = boxPath(rel)
    const open = workspace.find(path)
    if (open) return open.getText()
    const res = await window.api.readTextFile(path).catch(() => null)
    return res && res.kind === 'text' ? res.text : null
  },
  write: async (rel, text) => {
    const path = boxPath(rel)
    const open = workspace.find(path)
    if (open) {
      // In the editor: one undoable change; saved unless it had unsaved edits of yours.
      const hadEdits = open.dirty
      applyEditsToDoc(open, [textChange(open.buffer.getLines().join('\n'), text.replace(/\r\n/g, '\n'))])
      workspace.notifyChanged()
      if (!hadEdits) {
        await workspace.save(open)
        languages.didSave(open)
      }
      void refreshGit()
      if (/\.pyi?$/i.test(rel)) projectChangedSoon()
      return hadEdits ? 'unsaved' : 'saved'
    } else {
      const res = await window.api.readTextFile(path).catch(() => null)
      await window.api.writeTextFile(path, text, res && res.kind === 'text' ? res.encoding : 'utf8')
      languages.filesChangedOnDisk([path])
      void tree.refreshAll()
    }
    void refreshGit()
    if (/\.pyi?$/i.test(rel)) projectChangedSoon()
    return 'saved'
  },
  saveBoxes: async (file) => {
    if (rootFolder) await window.api.writeProjectFile(rootFolder, 'boxes.json', file)
  },
  note: (message) => statusNote(message)
}
const boxes = new BoxController(boxFiles)

/** Add an API box: on a module (its code goes at the end of that file), or in a new file. */
function addBox(module: string | null): void {
  if (!rootFolder) {
    alert('Open a folder first.')
    return
  }
  tasks.reveal('graph')
  const m = module ? projectGraph?.modules.find((x) => x.id === module) : undefined
  if (m) boxes.add({ module: m.id }, { file: m.path, mode: 'append' })
  else boxes.add(null)
  tasks.reveal('box')
}

const toolbox = new Toolbox({ add: () => addBox(null) })
const boxSettings = new BoxSettings(boxes, {
  // The last response stays in the window: only the box's settings are sent.
  testCall: (box, requestId) => window.api.apiTestCall(rootFolder ?? '', serializeBoxes([box]).boxes[0], requestId),
  envNames: () => (rootFolder ? window.api.envNames(rootFolder) : Promise.resolve([])),
  setSecret: (name, value) => (rootFolder ? window.api.setEnvValue(rootFolder, name, value) : Promise.reject(new Error('Open a folder first.'))),
  envIgnored: () => (rootFolder ? window.api.envIgnored(rootFolder) : Promise.resolve(true)),
  ignoreEnv: () => (rootFolder ? window.api.addEnvToGitignore(rootFolder).then(() => void refreshGit()) : Promise.resolve()),
  confirmCode: (title, code) => showCodeDialog({ title, code, ok: 'Write code' }),
  showDiff: (current, next) => showCodeDialog({ title: 'Replace your edits with the box\'s code? (- yours, + the box\'s)', diff: codeLineDiff(current, next), ok: 'Overwrite' }),
  confirm: (message) => confirm(message),
  alert: (message) => alert(message),
  openFile: (rel) => {
    try {
      const path = boxPath(rel)
      tasks.switchTo('code')
      void openFile(path)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  },
  liveWire: (id, on) => {
    if (on) liveBoxes.add(id)
    else liveBoxes.delete(id)
    graphView.redrawBoxes()
  }
})
boxes.onChange(() => {
  graphView.redrawBoxes()
  if (!boxes.selected && !dock.editing) closeIdleBoxSettings()
})
dock.register({ id: 'toolbox', title: 'Toolbox', body: toolbox.body })
dock.register({ id: 'box', title: 'Box settings', body: boxSettings.body, onShow: () => void boxSettings.refreshEnv() })

/** The project's boxes, from .forge/boxes.json. */
async function loadBoxes(folder: string): Promise<void> {
  const res = await window.api.readProjectFile(folder, 'boxes.json').catch(() => null)
  if (res?.error) statusNote(`.forge/boxes.json couldn't be read (${res.error}): its boxes aren't shown`)
  liveBoxes.clear()
  boxes.load(res?.exists && !res.error ? res.value : null)
  void boxSettings.refreshEnv()
}

// ---------- Network panel: the web requests a traced run makes ----------
const netLog = new NetLog()
const networkView = new NetworkView(netLog, {
  openFunc: (func) => {
    if (graphView.openTraced(func)) return
    // The Graph hasn't scanned yet: open the module's file by its name.
    const module = func.startsWith('module:') ? func.slice(7) : func.slice(0, func.indexOf(':'))
    if (!rootFolder) return
    const sep = rootFolder.includes('\\') ? '\\' : '/'
    tasks.switchTo('code')
    void openFile(rootFolder.replace(/[\\/]+$/, '') + sep + module.split('.').join(sep) + '.py', 0)
  },
  clear: () => {
    netLog.clear()
    networkView.update()
  }
})
panel.addView('network', 'Network', networkView.body, networkView.actions)
commands.register({ id: 'panel.network', title: 'Show Network (web requests while running)', run: () => panel.show('network') })

const graphView = new GraphView({
  scan: () => scanProjectGraph(),
  debugHistory: (node) => debugHistoryView(debugTrail, node),
  runDetails: (node) => recursionDetails(node),
  boxes: {
    list: () => boxes.boxes,
    selected: () => boxes.selected,
    select: (id) => {
      boxes.select(id)
      tasks.reveal('box')
    },
    clear: () => {
      // Box settings only show while a box is picked.
      if (!boxes.selected) return
      boxes.select(null)
      tasks.closePanel('box')
    },
    drop: (module) => addBox(module),
    live: () => (runBoxes.size ? new Set([...liveBoxes, ...runBoxes]) : liveBoxes)
  },
  openModule: (rel, line) => {
    if (!rootFolder) return
    const sep = rootFolder.includes('\\') ? '\\' : '/'
    const path = rootFolder.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
    tasks.switchTo('code')
    void openFile(path, line)
  },
})
dock.register({ id: 'graph', title: 'Graph', body: graphView.el, onShow: () => void graphView.refresh() })
commands.register({
  id: 'view.projectGraph', title: 'Show Project Graph', keys: 'Ctrl+Alt+G', when: () => rootFolder !== null,
  run: () => {
    diffView.hide()
    tasks.reveal('graph')
  }
})
commands.register({
  id: 'connect.addApiBox', title: 'Add API Box (Connect)', when: () => rootFolder !== null,
  run: () => {
    diffView.hide()
    tasks.reveal('graph')
    addBox(null)
  }
})

/** Switch to a branch, create one, or check out a remote branch. */
async function pickBranch(): Promise<void> {
  const repo = gitView.status
  if (!repo) return
  const list = await window.api.gitBranches(repo.root)
  const local = list.filter((b) => !b.remote)
  const localNames = new Set(local.map((b) => b.name))
  const remote = list.filter((b) => b.remote && !localNames.has(b.name.slice(b.name.indexOf('/') + 1)))
  const sw = (name: string, opts: { create: boolean; remote: boolean }) => {
    void gitRun(() => window.api.gitSwitch(repo.root, name, opts), opts.create ? 'Creating branch…' : 'Switching branch…')
  }
  palette.choose(`Switch branch (now on ${repo.branch ?? 'a detached HEAD'})`, [
    { label: '+ Create new branch…', detail: `from ${repo.branch ?? 'HEAD'}`, run: () => setTimeout(() => palette.prompt('Name for the new branch, e.g. feature/login', (name) => sw(name.trim(), { create: true, remote: false }), '', 'Create branch')) },
    ...local.map((b) => ({
      label: b.name,
      detail: b.upstream ? `tracks ${b.upstream}` : undefined,
      hint: b.current ? '✓ current' : undefined,
      run: () => { if (!b.current) sw(b.name, { create: false, remote: false }) }
    })),
    ...remote.map((b) => ({ label: b.name, detail: 'remote branch: check it out locally', hint: 'remote', run: () => sw(b.name, { create: false, remote: true }) }))
  ])
}

/** Diff of the active file (unstaged changes first, else staged ones). */
async function diffActiveFile(): Promise<void> {
  const doc = workspace.active
  await refreshGit()
  const repo = gitView.status
  if (!doc || !repo) return statusNote(repo ? 'Open a file first.' : "This folder isn't a git repository.")
  const rel = doc.path.slice(repo.root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  const same = (p: string) => (/^[a-zA-Z]:/.test(repo.root) ? p.toLowerCase() === rel.toLowerCase() : p === rel)
  const unstaged = repo.unstaged.find((c) => same(c.path))
  const staged = repo.staged.find((c) => same(c.path))
  if (unstaged) return diffView.show(repo, unstaged, false)
  if (staged) return diffView.show(repo, staged, true)
  statusNote(doc.dirty ? 'No changes on disk yet: save the file to compare it.' : 'This file has no changes since the last commit.')
}

// ---------- history, blame, merge conflicts ----------

/** The active file's path relative to the repository (with /), or null. */
function repoPath(doc: Doc | null = workspace.active): string | null {
  const repo = gitView.status
  if (!doc || !repo || !isInside(doc.path, repo.root)) return null
  return doc.path.slice(repo.root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

const historyView = new HistoryView({
  repo: () => gitView.status,
  activeFile: () => repoPath(),
  showCommitFile: (repo, sha, subject, path) => void diffView.showCommitFile(repo, sha, subject, path),
  openFile: (path) => {
    const repo = gitView.status
    if (repo) void openFile(repo.root + (repo.root.includes('\\') ? '\\' : '/') + path)
  }
})
panel.addView('history', 'History', historyView.body, historyView.actions, () => void historyView.load())

// Blame: the cursor line's author in the status bar; every line in the gutter when turned on.
let blameOn = false
let blame: { doc: Doc; version: number; lines: BlameLine[] } | null = null
let blameTimer: number | undefined
let blameGeneration = 0

function blameText(l: BlameLine): string {
  return l.uncommitted ? 'You · not committed yet' : `${l.author} · ${timeAgo(l.time)} · ${l.summary}`
}

/** Fetch blame for the active file (using its current text, so unsaved edits line up). */
function refreshBlameSoon(delay = 600): void {
  window.clearTimeout(blameTimer)
  blameTimer = window.setTimeout(() => void loadBlame(), delay)
}

async function loadBlame(): Promise<void> {
  const doc = workspace.active
  const repo = gitView.status
  const rel = repoPath(doc)
  if (!doc || !repo || !rel || doc.large || repo.unstaged.some((c) => c.path === rel && c.kind === 'untracked')) {
    blame = null
    applyBlame()
    return
  }
  if (blame && blame.doc === doc && blame.version === doc.version) return applyBlame()
  const gen = ++blameGeneration
  const version = doc.version
  const res = await window.api.gitBlame(repo.root, rel, doc.getText()).catch(() => null)
  if (gen !== blameGeneration || workspace.active !== doc) return
  blame = res?.ok ? { doc, version, lines: res.lines } : null
  applyBlame()
}

function applyBlame(): void {
  const doc = workspace.active
  const usable = blame && blame.doc === doc && blame.version === doc?.version ? blame : null
  editors.forEach((ed, i) => {
    if (i !== workspace.activeGroup || !blameOn || !usable) return ed.setGutterNotes(null)
    // Only the first line of each run from the same commit, to keep it readable.
    ed.setGutterNotes(usable.lines.map((l, k) => (k > 0 && usable.lines[k - 1].sha === l.sha ? '' : l.uncommitted ? 'not committed yet' : `${l.author.split(' ')[0]} · ${timeAgo(l.time)}`)))
  })
  scheduleStatus()
}

function lineBlame(): string {
  const doc = workspace.active
  if (!blame || blame.doc !== doc || blame.version !== doc?.version) return ''
  const l = blame.lines[editor.getCursor().line]
  return l ? blameText(l) : ''
}

// Merge conflicts in the active file: shaded, with a bar to resolve them.
const conflictBar = document.createElement('div')
conflictBar.className = 'conflict-bar'
conflictBar.hidden = true
$('editor-pane').append(conflictBar)
let conflictCache: { doc: Doc; version: number; list: Conflict[] } | null = null

function conflictsOf(doc: Doc): Conflict[] {
  if (conflictCache?.doc === doc && conflictCache.version === doc.version) return conflictCache.list
  const lines = doc.buffer.getLines()
  const list = doc.large || !lines.some((l) => l.startsWith('<<<<<<<')) ? [] : findConflicts(lines)
  conflictCache = { doc, version: doc.version, list }
  editors.forEach((ed, i) => ed.setLineShades(i === workspace.activeGroup ? conflictShades(list) : []))
  return list
}

function conflictShades(list: Conflict[]): { from: number; to: number; cls: string }[] {
  const out: { from: number; to: number; cls: string }[] = []
  for (const c of list) {
    const mid = c.base ?? c.separator
    out.push({ from: c.start, to: c.start, cls: 'conflict-marker' })
    out.push({ from: c.start + 1, to: mid - 1, cls: 'conflict-current' })
    if (c.base !== null) out.push({ from: c.base, to: c.base, cls: 'conflict-marker' }, { from: c.base + 1, to: c.separator - 1, cls: 'conflict-base' })
    out.push({ from: c.separator, to: c.separator, cls: 'conflict-marker' })
    out.push({ from: c.separator + 1, to: c.end - 1, cls: 'conflict-incoming' })
    out.push({ from: c.end, to: c.end, cls: 'conflict-marker' })
  }
  return out
}

let conflictBarKey = ''
function updateConflictBar(): void {
  const doc = workspace.active
  const list = doc ? conflictsOf(doc) : []
  const rel = repoPath(doc)
  const unresolved = !!rel && !!gitView.status?.conflicts.some((c) => c.path === rel)
  const cur = list.length && doc ? conflictNear(list, editor.getCursor().line) : null
  const key = `${doc?.path}|${doc?.version}|${list.indexOf(cur!)}|${unresolved}`
  if (key === conflictBarKey) return
  conflictBarKey = key
  if (!doc || (!list.length && !unresolved)) {
    conflictBar.hidden = true
    return
  }
  const btn = (text: string, title: string, fn: () => void) => {
    const b = document.createElement('button')
    b.textContent = text
    b.title = title
    b.addEventListener('click', fn)
    return b
  }
  const label = document.createElement('span')
  if (cur) {
    label.textContent = `⚠ Merge conflict ${list.indexOf(cur) + 1} of ${list.length}`
    conflictBar.replaceChildren(
      label,
      btn(`Accept Current${cur.currentLabel ? ` (${cur.currentLabel})` : ''}`, 'Keep your side (green)', () => resolveCurrentConflict('current')),
      btn(`Accept Incoming${cur.incomingLabel ? ` (${cur.incomingLabel})` : ''}`, 'Take the incoming side (blue)', () => resolveCurrentConflict('incoming')),
      btn('Accept Both', 'Keep both, yours first', () => resolveCurrentConflict('both')),
      btn('◀', 'Previous conflict', () => goToConflict(-1)),
      btn('▶', 'Next conflict', () => goToConflict(1))
    )
  } else {
    label.textContent = '✓ No conflicts left in this file.'
    conflictBar.replaceChildren(label, btn('Save and Mark Resolved', 'Save the file and stage it (git add)', () => void markResolved()))
  }
  conflictBar.hidden = false
}

function resolveCurrentConflict(choice: Resolution): void {
  const doc = workspace.active
  if (!doc) return
  const list = conflictsOf(doc)
  const c = conflictNear(list, editor.getCursor().line)
  if (!c) return
  const lines = doc.buffer.getLines()
  const keep = resolveConflict(lines, c, choice)
  const last = lines.length - 1
  // Replace the whole block (start..end lines, including the line break after it).
  const edit: TextEdit = c.end < last
    ? { start: { line: c.start, col: 0 }, end: { line: c.end + 1, col: 0 }, text: keep.length ? keep.join('\n') + '\n' : '' }
    : c.start > 0 && !keep.length
      ? { start: { line: c.start - 1, col: lines[c.start - 1].length }, end: { line: c.end, col: lines[c.end].length }, text: '' }
      : { start: { line: c.start, col: 0 }, end: { line: c.end, col: lines[c.end].length }, text: keep.join('\n') }
  applyEditsToDoc(doc, [edit])
  editor.goTo(Math.min(c.start, doc.buffer.lineCount - 1), 0)
  updateConflictBar()
}

function goToConflict(delta: 1 | -1): void {
  const doc = workspace.active
  if (!doc) return
  const list = conflictsOf(doc)
  if (!list.length) return
  const line = editor.getCursor().line
  const i = list.findIndex((c) => line >= c.start && line <= c.end)
  const next = i === -1
    ? (delta === 1 ? list.find((c) => c.start > line) ?? list[0] : [...list].reverse().find((c) => c.end < line) ?? list[list.length - 1])
    : list[(i + delta + list.length) % list.length]
  editor.goTo(next.start, 0)
  editor.focus()
}

async function markResolved(): Promise<void> {
  const doc = workspace.active
  const repo = gitView.status
  const rel = repoPath(doc)
  if (!doc || !repo || !rel) return
  if (doc.dirty && !(await saveActive())) return
  await gitRun(() => window.api.gitStage(repo.root, [rel]), 'Staging…')
  conflictBarKey = ''
  updateConflictBar()
}

const inConflict = () => !!workspace.active && conflictsOf(workspace.active).length > 0
commands.register({ id: 'git.acceptCurrent', title: 'Merge Conflict: Accept Current', when: inConflict, run: () => resolveCurrentConflict('current') })
commands.register({ id: 'git.acceptIncoming', title: 'Merge Conflict: Accept Incoming', when: inConflict, run: () => resolveCurrentConflict('incoming') })
commands.register({ id: 'git.acceptBoth', title: 'Merge Conflict: Accept Both', when: inConflict, run: () => resolveCurrentConflict('both') })
commands.register({ id: 'git.nextConflict', title: 'Merge Conflict: Next', when: inConflict, run: () => goToConflict(1) })
commands.register({ id: 'git.prevConflict', title: 'Merge Conflict: Previous', when: inConflict, run: () => goToConflict(-1) })
commands.register({ id: 'git.history', title: 'Git: Show History', when: () => gitView.status !== null, run: () => { panel.show('history') } })
commands.register({
  id: 'git.fileHistory', title: 'Git: File History', when: () => repoPath() !== null,
  run: () => { panel.show('history'); void historyView.showFile(repoPath()!) }
})
commands.register({
  id: 'git.toggleBlame', title: 'Git: Toggle Blame (who changed each line)', when: () => gitView.status !== null,
  run: () => {
    blameOn = !blameOn
    statusNote(blameOn ? 'Blame on: who last changed each line is shown next to the line numbers.' : 'Blame off.')
    if (blameOn) void loadBlame()
    else applyBlame()
  }
})
$('sb-blame').addEventListener('click', () => commands.run('git.fileHistory'))

commands.register({ id: 'git.show', title: 'Show Source Control (Git)', keys: 'Ctrl+Shift+G', run: () => { showSidebar('git'); gitView.focusMessage() } })
commands.register({ id: 'git.diffFile', title: 'Git: Show Changes in This File', when: () => hasDocNow() && rootFolder !== null, run: () => void diffActiveFile() })
commands.register({ id: 'git.commit', title: 'Git: Commit', when: () => gitView.status !== null, run: () => { showSidebar('git'); void gitView.commit() } })
commands.register({ id: 'git.branch', title: 'Git: Switch Branch…', when: () => gitView.status !== null, run: () => void pickBranch() })
commands.register({ id: 'git.pull', title: 'Git: Pull', when: () => gitView.status !== null, run: () => void gitRun(() => window.api.gitSync(gitView.status!.root, 'pull'), 'Pulling…') })
commands.register({ id: 'git.push', title: 'Git: Push', when: () => gitView.status !== null, run: () => void gitRun(() => window.api.gitSync(gitView.status!.root, 'push'), 'Pushing…') })
commands.register({ id: 'git.fetch', title: 'Git: Fetch', when: () => gitView.status !== null, run: () => void gitRun(() => window.api.gitSync(gitView.status!.root, 'fetch'), 'Fetching…') })
commands.register({ id: 'git.stageAll', title: 'Git: Stage All Changes', when: () => !!gitView.status?.unstaged.length, run: () => void gitRun(() => window.api.gitStage(gitView.status!.root, gitView.status!.unstaged.map((c) => c.path)), 'Staging…') })
commands.register({ id: 'git.init', title: 'Git: Initialize Repository', when: () => rootFolder !== null && gitView.status === null, run: () => void gitRun(() => window.api.gitInit(rootFolder!), 'Creating repository…') })
$('sb-branch').addEventListener('click', () => void pickBranch())

// ---------- sidebar: Files | Search ----------

const searchView = new SearchView(
  () => rootFolder,
  async (path, line, col, length) => {
    if (await openFile(path)) editor.select({ line, col }, { line, col: col + length })
    editor.focus()
  }
)
$('search-panel').append(searchView.root)

type SidebarView = 'files' | 'search' | 'outline' | 'git'
/** Files, Search, Outline and Git are panels: show one in the current task. */
function showSidebar(view: SidebarView): void {
  tasks.reveal(view)
  if (view === 'git') void refreshGit()
  if (view === 'outline') void refreshOutline()
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

// ---------- Python environment and packages ----------

const pyEnv = new PythonEnv({
  palette,
  root: () => rootFolder,
  configuredPython: () => settings.pythonPath || undefined,
  setProjectPython: async (path) => {
    if (!rootFolder) return
    const folder = rootFolder
    await window.api.updateProjectSettings(folder, { pythonPath: path })
    await loadProjectSettings(folder)
    void tree.refreshAll()
  },
  runTool,
  writeFile: async (path, text) => {
    const open = workspace.find(path)
    if (open?.dirty) {
      alert(`${open.name} has unsaved changes. Save or close it first.`)
      return false
    }
    try {
      await window.api.writeTextFile(path, text, open?.encoding ?? 'utf8')
      if (open) workspace.discard([open]) // reopened fresh below
      void tree.refreshAll()
      return true
    } catch (err) {
      alert(`Couldn't write ${path}:\n${String(err)}`)
      return false
    }
  },
  openFile: (path) => void openFile(path),
  changed: scheduleStatus,
  envChanged: () => void window.api.forgetTools().then(() => codeTools.retry(workspace.docs)),
  report: (message) => alert(message)
})

let envTimer: number | undefined
/** Re-check the interpreter and dependencies shortly (several triggers in a row check once). */
function refreshPythonEnv(): void {
  window.clearTimeout(envTimer)
  envTimer = window.setTimeout(() => void pyEnv.refresh(), 300)
}

commands.register({ id: 'python.selectInterpreter', title: 'Select Python Interpreter…', when: () => rootFolder !== null, run: () => void pyEnv.pickInterpreter() })
commands.register({ id: 'python.createVenv', title: 'Create Virtual Environment (.venv)…', when: () => rootFolder !== null, run: () => void pyEnv.createVenv() })
commands.register({ id: 'python.packages', title: 'Python Packages…', when: () => rootFolder !== null, run: () => void pyEnv.showPackages() })
commands.register({ id: 'python.installRequirements', title: 'Install Requirements (requirements.txt)', when: () => rootFolder !== null, run: () => pyEnv.installRequirements() })
commands.register({ id: 'python.checkDeps', title: 'Check Dependencies', when: () => rootFolder !== null, run: () => void pyEnv.refresh().then(() => pyEnv.missing.length ? pyEnv.showMissing() : alert('Every package in requirements.txt / pyproject.toml is installed.')) })

// ---------- tests (pytest / unittest) ----------

const tests = new TestView({
  root: () => rootFolder,
  python: async () => {
    if (!pyEnv.current) await pyEnv.refresh()
    return pyEnv.current?.path ?? null
  },
  open: (path, line) => void openFile(path, line),
  saveAll: () => saveAllDirty((m) => alert(`Couldn't save before testing: ${m}`)),
  installPytest: () => pyEnv.install('pytest'),
  changed: (failed) => panel.setTitle('tests', failed ? `Tests (${failed} ✗)` : 'Tests')
})
panel.addView('tests', 'Tests', tests.body, tests.actions, () => tests.show())

const showTests = () => panel.show('tests')
commands.register({ id: 'tests.show', title: 'Show Tests', when: () => rootFolder !== null, run: showTests })
commands.register({ id: 'tests.runAll', title: 'Run All Tests', when: () => rootFolder !== null && !tests.isRunning, run: () => { showTests(); void tests.run('all') } })
commands.register({ id: 'tests.runFailed', title: 'Run Failed Tests Again', when: () => rootFolder !== null && !tests.isRunning, run: () => { showTests(); void tests.run('failed') } })
commands.register({
  id: 'tests.runFile', title: 'Run Tests in This File', when: () => hasDoc() && !tests.isRunning,
  run: () => { showTests(); void tests.runFile(workspace.active!.path) }
})
commands.register({
  id: 'tests.runAtCursor', title: 'Run Test at Cursor', when: () => hasDoc() && !tests.isRunning,
  run: () => { showTests(); void tests.runAt(workspace.active!.path, editor.getCursor().line) }
})
commands.register({ id: 'tests.stop', title: 'Stop Tests', when: () => tests.isRunning, run: () => void window.api.stopTests() })

// ---------- code quality: Ruff warnings, quick fixes, formatting ----------

let noteTimer: number | undefined
/** A short message in the status bar that goes away by itself. */
function statusNote(text: string): void {
  const el = $('sb-note')
  el.textContent = text
  window.clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => { el.textContent = '' }, 4000)
}

/** Apply edits to several files: open ones in place (undoable), others on disk. */
async function applyWorkspaceEdits(edits: FileEdits): Promise<boolean> {
  const failed: string[] = []
  const onDisk: string[] = []
  for (const [path, list] of edits) {
    const open = workspace.find(path)
    if (open) {
      applyEditsToDoc(open, list)
      continue
    }
    try {
      const res = await window.api.readTextFile(path)
      if (res.kind !== 'text') throw new Error('not a text file')
      await window.api.writeTextFile(path, applyEdits(res.text, list), res.encoding)
      onDisk.push(path)
    } catch (err) {
      failed.push(`${path} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  languages.filesChangedOnDisk(onDisk)
  workspace.notifyChanged()
  if (failed.length) alert(`These files couldn't be changed:\n${failed.join('\n')}`)
  return failed.length === 0
}
languages.applyEditHandler = applyWorkspaceEdits

const codeTools = new CodeTools({
  languages,
  palette,
  root: () => rootFolder,
  interpreter: () => pyEnv.current?.path ?? null,
  settings: () => settings,
  active: () => workspace.active,
  selection: () => {
    const { anchor, head } = editor.getSelection()
    const headFirst = head.line < anchor.line || (head.line === anchor.line && head.col < anchor.col)
    return headFirst ? { start: head, end: anchor } : { start: anchor, end: head }
  },
  applyEdits: (doc, edits) => applyEditsToDoc(doc, edits),
  applyFileEdits: applyWorkspaceEdits,
  install: (tool) => pyEnv.install(tool),
  setLightbulb: (line) => editors.forEach((ed, i) => ed.setLightbulb(i === workspace.activeGroup ? line : null)),
  note: statusNote,
  report: (message) => alert(message)
})
workspace.subscribe(() => codeTools.sync(workspace.docs))

const pyDoc = () => hasDocNow() && /\.pyi?$/i.test(workspace.active!.path)
commands.register({ id: 'editor.quickFix', title: 'Quick Fix…', keys: 'Ctrl+.', when: hasDocNow, run: () => void codeTools.quickFix() })
commands.register({ id: 'editor.format', title: 'Format Document', keys: 'Shift+Alt+F', when: pyDoc, run: () => void codeTools.format() })
commands.register({ id: 'editor.formatSelection', title: 'Format Selection', when: pyDoc, run: () => void codeTools.format({ selection: true }) })
commands.register({ id: 'editor.organizeImports', title: 'Organize Imports', keys: 'Shift+Alt+O', when: pyDoc, run: () => void codeTools.organizeImports() })
commands.register({ id: 'editor.fixAll', title: 'Fix All Auto-fixable Problems (Ruff)', when: pyDoc, run: () => void codeTools.fixAll() })
commands.register({ id: 'python.installRuff', title: 'Install Ruff (linter and formatter)', when: () => rootFolder !== null, run: () => pyEnv.install('ruff') })

// ---------- keyboard shortcuts you can change ----------

const shortcuts = new Shortcuts(commands, palette, (message) => alert(message))
commands.register({ id: 'keys.show', title: 'Keyboard Shortcuts…', run: () => shortcuts.showList() })
commands.register({ id: 'keys.openFile', title: 'Edit Keyboard Shortcuts File (keybindings.json)', run: () => void shortcuts.openFile((p) => void openFile(p)) })
settingsView.setLinks([
  { label: 'Keyboard Shortcuts…', run: () => shortcuts.showList() },
  { label: 'Project Settings…', run: () => commands.run('settings.project') }
])
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
    const lang = doc.mode.language
    set('sb-lang', doc.large && lang.server ? `${lang.name} (large file: no error checking)` : lang.name)
  } else {
    for (const id of ['sb-cursor', 'sb-indent', 'sb-encoding', 'sb-eol', 'sb-lang']) set(id, '')
  }
  const all = languages.allDiagnostics()
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
  if (!$('outline-panel').hidden) outline.highlight(doc ? editor.getCursor() : null)
  codeTools.updateLightbulb(doc, doc ? editor.getCursor().line : null)
  updateOccurrences()
  updateConflictBar()
  const who = lineBlame()
  set('sb-blame', who.length > 70 ? who.slice(0, 69) + '…' : who)
  $('sb-blame').title = who ? `${who}\nClick for this file's history` : ''
  set('sb-debug', processes.some((p) => p.session.state === 'paused') ? '🐞 Paused' : rootSession?.active ? '🐞 Debugging' : '')
  const busy = output.isRunning || debugging()
  const runButton = $('run-button')
  const runLabel = busy ? '■ Stop' : '▶ Run'
  if (runButton.textContent !== runLabel) {
    runButton.textContent = runLabel
    runButton.classList.toggle('stop', busy)
    runButton.title = busy ? 'Stop (Shift+F5)' : 'Run (F5 / Ctrl+F5)'
  }
  set('project-branch', gitView.status?.branch ? ` · ${gitView.status.branch}` : '')
  set('sb-run', rootFolder ? `▶ ${runConfigName ?? 'Current file'}` : '')
  set('sb-python', pyEnv.statusText)
  set('sb-deps', pyEnv.missingText)
  $('sb-python').title = pyEnv.current ? `${pyEnv.current.path}\nClick to pick another interpreter or create a .venv` : 'Click to pick a Python interpreter'
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
$('sb-run').addEventListener('click', () => commands.run('run.selectConfig'))
$('sb-python').addEventListener('click', () => commands.run('python.selectInterpreter'))
$('sb-deps').addEventListener('click', () => pyEnv.showMissing())
languages.onDiagnostics(scheduleStatus)
updateStatus()

commands.register({
  id: 'terminal.new', title: 'New Terminal', keys: 'Ctrl+Shift+`',
  run: () => {
    panel.show('terminal')
    void terminal.newTerminal()
  }
})
commands.register({
  id: 'terminal.newWithShell', title: 'New Terminal with Shell…',
  run: () => {
    panel.show('terminal')
    void terminal.newTerminalWithShell()
  }
})
commands.register({ id: 'terminal.kill', title: 'Kill Terminal', when: () => panel.activeView === 'terminal', run: () => terminal.killActive() })
commands.register({ id: 'terminal.next', title: 'Next Terminal', when: () => panel.activeView === 'terminal', run: () => terminal.next() })
commands.register({ id: 'palette.commands', title: 'Show All Commands', keys: 'Ctrl+Shift+P', run: () => void palette.open('>') })
commands.register({ id: 'palette.files', title: 'Go to File…', keys: 'Ctrl+P', when: () => rootFolder !== null, run: () => void palette.open('') })
commands.register({ id: 'palette.line', title: 'Go to Line…', keys: 'Ctrl+G', when: hasDoc, run: () => void palette.open(':') })

for (const b of document.querySelectorAll<HTMLButtonElement>('#task-switcher button')) {
  b.addEventListener('click', () => tasks.switchTo(b.dataset.task as TaskId))
}
// ▶ Run, or ■ Stop while something runs.
$('run-button').addEventListener('click', () => commands.run(output.isRunning || debugging() ? 'run.stop' : 'run.smart'))

// While typing in the terminal, keys belong to the shell (Ctrl+C, Ctrl+W, Ctrl+F...).
// Only these IDE commands' shortcuts still work there (whatever keys they're set to).
const TERMINAL_PASSTHROUGH = new Set([
  'terminal.new', 'terminal.toggle', 'panel.toggle', 'palette.commands', 'tab.next', 'tab.prev',
  'run.smart', 'run.stop', 'run.file', 'settings.open', 'debug.restart',
  'debug.toggleBreakpoint', 'debug.stepOver', 'debug.stepInto', 'debug.stepOut'
])
const PALETTE_TOGGLES = new Set(['palette.commands', 'palette.files', 'palette.line'])

// Global shortcuts. Capture phase, so they win over the editor's own key handling.
window.addEventListener('keydown', (e) => {
  if (palette.capturing) return // the palette is recording a new shortcut
  const command = commands.commandForKey(keyString(e))
  if (!command) return
  if (terminal.hasFocus && !TERMINAL_PASSTHROUGH.has(command.id)) return
  // Dialogs handle their own keys (Escape, arrows...); only their toggles pass through.
  if (settingsView.isOpen && command.id !== 'settings.open') return
  if (palette.isOpen && !PALETTE_TOGGLES.has(command.id)) return
  e.preventDefault()
  e.stopPropagation()
  void command.run()
}, { capture: true })

// Block closing the window with unsaved changes; the main process then asks the user.
window.addEventListener('beforeunload', (e) => {
  saveStateNow()
  if (workspace.anyDirty) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// ---------- startup ----------

// Every command is registered by now, so the menu can show all their shortcuts.
void shortcuts.load()

const TASK_NAMES: Record<TaskId, string> = { code: 'Code', connect: 'Connect', debug: 'Debug', run: 'Run' }
TASKS.forEach((t, i) => commands.register({ id: `task.${t}`, title: `Switch to ${TASK_NAMES[t]}`, keys: `Ctrl+Alt+${i + 1}`, run: () => tasks.switchTo(t) }))
commands.register({ id: 'view.resetLayout', title: 'Reset Layout of This Task', run: () => tasks.resetCurrent() })
commands.register({ id: 'view.editLayout', title: 'Edit Layout (move, close and add panels)', run: () => setEditingLayout(!dock.editing) })
// The dock starts with the defaults, then your saved arrangements.
tasks.switchTo('code')
void window.api.getLayouts().catch(() => ({})).then((saved) => tasks.useSaved(saved))
window.addEventListener('beforeunload', () => tasks.flush())

void window.api.getSettings().then(async (s) => {
  userSettings = s
  settingsView.set(s)
  applyEffective()
  updateWelcome()
  // The editors measured their characters before the code font may have loaded: measure again once it has.
  void Promise.all([document.fonts.load('14px "JetBrains Mono"'), document.fonts.load('13px "Space Grotesk"')])
    .catch(() => [])
    .then(() => {
      for (const ed of editors) ed.refreshLayout(settings.tabSize)
      terminal.applyTheme(settings.fontSize)
    })
  // Reopen the last project (with its tabs), unless that's turned off or it's gone.
  if (s.reopenLastProject && !rootFolder) {
    try {
      const [last] = await window.api.recentList()
      const res = last ? await window.api.checkFolder(last) : null
      if (typeof res === 'string' && !rootFolder) {
        await openFolderPath(res)
        return
      }
    } catch { /* fall through to the recent list */ }
  }
  refreshRecentSidebar()
})

export { workspace, editor, saveActive }
export const getRootFolder = () => rootFolder
