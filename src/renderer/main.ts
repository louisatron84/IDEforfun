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
import { DEFAULT_SETTINGS, effectiveSettings, type ProjectSettings, type Settings } from '../shared/settings'
import type { WorkspaceState } from '../shared/projectState'
import { Shortcuts } from './shortcuts'
import { PythonEnv, type PythonTool } from './pythonEnv'
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
const findBar = new FindBar($('editor-pane'), editor)
const panel = new Panel($('editor-pane'))
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
let session: DebugSession | null = null
/** Where the paused program is (shown with a ▶ in the gutter and a highlighted line). */
let pausedAt: { path: string; line: number } | null = null
/** What the last debug session ran (for Restart). */
let lastDebugSpec: LaunchSpec | null = null

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

/** Save every changed file (programs read them from disk). Returns false if one couldn't be saved. */
async function saveAllDirty(report: (message: string) => void): Promise<boolean> {
  for (const doc of workspace.docs.filter((d) => d.dirty)) {
    try {
      await workspace.save(doc)
      python.didSave(doc)
    } catch (err) {
      report(`couldn't save ${doc.name} (${String(err)})`)
      return false
    }
  }
  return true
}

async function startDebugging(given?: LaunchSpec): Promise<void> {
  const resolved = given ?? launchSpec()
  if (session?.active) await stopDebugging()
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
    await s.start({ program: spec.program, module: spec.module, args: spec.args, env: spec.env, cwd, breakpoints: breakpoints.all() })
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
  const spec = lastDebugSpec
  await stopDebugging()
  if (spec) await startDebugging(spec)
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

/** The settings in effect: yours, with the open project's overrides on top. */
let settings: Settings = DEFAULT_SETTINGS
/** Your own settings (settings.json), as shown in the Settings dialog. */
let userSettings: Settings = DEFAULT_SETTINGS
/** What the open project's .ideforfun/settings.json overrides. */
let projectSettings: ProjectSettings = {}
let projectSettingsPath: string | null = null

function applySettings(s: Settings, restartLsp = true): void {
  const pythonChanged = s.pythonPath !== settings.pythonPath
  settings = s
  if (pythonChanged && rootFolder && restartLsp) {
    void startLanguageServer()
    refreshPythonEnv()
  }
  const root = document.documentElement
  root.style.setProperty('--code-size', `${s.fontSize}px`)
  root.style.setProperty('--line-height', `${Math.round(s.fontSize * 1.45)}px`)
  root.style.setProperty('--tab-size', String(s.tabSize))
  root.dataset.theme = s.theme
  for (const ed of editors) ed.refreshLayout(s.tabSize)
  terminal.applyTheme(s.fontSize)
}

/** A relative interpreter path in project settings (.venv/bin/python) is relative to the project. */
function resolveInProject(path: string | undefined): string | undefined {
  if (!path || !rootFolder || /^([a-zA-Z]:|[\\/]|~)/.test(path) || !/[\\/]/.test(path)) return path
  const sep = rootFolder.includes('\\') ? '\\' : '/'
  return rootFolder.replace(/[\\/]+$/, '') + sep + path.replace(/^\.[\\/]/, '')
}

const SETTING_NAMES: Record<string, string> = { tabSize: 'Tab width', pythonPath: 'Python interpreter', shell: 'Terminal shell' }

/** Recompute the settings in effect after yours or the project's change. */
function applyEffective(restartLsp = true): void {
  const project = { ...projectSettings }
  if (project.pythonPath !== undefined) project.pythonPath = resolveInProject(project.pythonPath) ?? ''
  applySettings(effectiveSettings(userSettings, project), restartLsp)
  const keys = Object.keys(projectSettings)
  settingsView.setProjectNote(
    keys.length
      ? `This project's .ideforfun/settings.json sets: ${keys.map((k) => SETTING_NAMES[k] ?? k).join(', ')}. ` +
        'Those rows show your own setting; the project\'s value is used while it is open.'
      : rootFolder ? 'A project can set tabSize, pythonPath and shell in .ideforfun/settings.json (Project Settings below).' : null
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

/** Read <project>/.ideforfun/settings.json (a missing file means no overrides). */
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
workspace.subscribe(() => {
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
  python.syncDocs(workspace.docs.filter((d) => !d.large))
  backups.sync(workspace.docs)
  saveStateSoon()
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
    if (shortcuts.path && samePath(doc.path, shortcuts.path)) void shortcuts.load()
    if (rootFolder && projectSettingsPath && samePath(doc.path, projectSettingsPath)) void loadProjectSettings(rootFolder)
    if (rootFolder && runFilePath && samePath(doc.path, runFilePath)) void loadRunFile(rootFolder)
    if (rootFolder && /^(requirements\.txt|pyproject\.toml)$/i.test(doc.name) && samePath(parentDir(doc.path), rootFolder)) refreshPythonEnv()
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
    folderName.textContent = folder
    folderName.classList.remove('muted')
    void window.api.recentAdd(folder).catch(() => {})
    await loadProjectSettings(folder, false)
    runConfigName = null
    lastTask = null
    await loadRunFile(folder)
    await tree.setRoot(folder)
    workspace.notifyChanged()
    void refreshGit()
    lspRestarts = 0
    void startLanguageServer()
    refreshPythonEnv()
    await restoreLayout(folder)
  } finally {
    restoringState = false
  }
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
    runConfig: runConfigName
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
  scheduleStatus()
  terminal.setPending(state.terminals)
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
  await window.api.runPython({ ...spec, root: rootFolder ?? spec.cwd, python: settings.pythonPath || undefined })
  editor.focus()
}

// ---------- run configurations and tasks (.ideforfun/run.json) ----------

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
    { label: runFile.configurations.length ? 'Edit run configurations…' : 'Add a run configuration…', detail: '.ideforfun/run.json', run: () => void editRunFile() }
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
    { label: runFile.tasks.length ? 'Edit tasks…' : 'Add a task…', detail: '.ideforfun/run.json', run: () => void editRunFile() }
  ]
  palette.choose(runFile.tasks.length ? 'Run a task (in a new terminal)' : 'No tasks yet: add some to .ideforfun/run.json', items)
}

/** What to do when a tool run (pip, venv) ends, by run id. */
const afterRun = new Map<number, (code: number | null) => void>()
let lastExit: { runId: number; code: number | null } | null = null

window.api.onRunEvent((e) => {
  if (e.runId < lastRunId) return // late event from a run we already replaced
  lastRunId = e.runId
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
    if (debugPaused()) return void session!.continue()
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
    else if (output.isRunning) void window.api.stopRun()
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
  run: () => updateUserSettings({ fontSize: Math.min(28, userSettings.fontSize + 1) })
})
commands.register({
  id: 'view.zoomOut', title: 'Decrease Font Size', keys: 'Ctrl+-',
  run: () => updateUserSettings({ fontSize: Math.max(10, userSettings.fontSize - 1) })
})
commands.register({
  id: 'view.toggleTheme', title: 'Toggle Light/Dark Theme',
  run: () => updateUserSettings({ theme: userSettings.theme === 'dark' ? 'light' : 'dark' })
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
python.onDiagnostics(scheduleStatus)
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

$('open-settings').addEventListener('click', () => settingsView.open())
$('run-file').addEventListener('click', () => void runCurrentFile())
$('debug-file').addEventListener('click', () => void startDebugging())
$('stop-run').addEventListener('click', () => void window.api.stopRun())
$('open-folder').addEventListener('click', () => void openFolder())

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

void window.api.getSettings().then(async (s) => {
  userSettings = s
  settingsView.set(s)
  applyEffective()
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
