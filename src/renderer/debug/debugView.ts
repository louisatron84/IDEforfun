/**
 * The Debug panel: step buttons, the call stack, variables (expandable), and
 * a console showing the program's output where you can evaluate expressions
 * while paused.
 */
import { findFileLinks, stripAnsi } from '../../shared/traceback'
import type { DebugState, ExceptionFilter, PauseInfo, StackFrame, Variable } from './session'
import type { SavedBreakpoint } from './breakpoints'

export interface DebugViewHooks {
  continue(): void
  stepOver(): void
  stepInto(): void
  stepOut(): void
  stop(): void
  restart(): void
  /** The user picked a frame in the call stack. */
  selectFrame(frame: StackFrame): void
  scopes(frameId: number): Promise<{ name: string; ref: number; expensive: boolean }[]>
  variables(ref: number): Promise<Variable[]>
  evaluate(expression: string): Promise<{ result: string; ref: number }>
  openLink(path: string, line: number): void
  /** Show another thread's call stack. */
  selectThread(threadId: number): Promise<StackFrame[]>
  /** Show another process (the program or one of its child processes). */
  selectProcess(id: number): void
  /** Evaluate a watch expression in the selected frame. */
  watch(expression: string, frameId: number | undefined): Promise<{ result: string; ref: number }>
  watchesChanged(watches: string[]): void
  // Breakpoints panel
  breakpoints(): SavedBreakpoint[]
  goToBreakpoint(b: SavedBreakpoint): void
  setBreakpointEnabled(b: SavedBreakpoint, enabled: boolean): void
  editBreakpoint(b: SavedBreakpoint): void
  removeBreakpoint(b: SavedBreakpoint): void
  setAllBreakpoints(enabled: boolean): void
  removeAllBreakpoints(): void
  /** Exception settings: which are offered, which are on. */
  exceptionFilters(): { offered: ExceptionFilter[]; on: string[] }
  setExceptionFilter(filter: string, on: boolean): void
  relative(path: string): string
}

const MAX_LOG = 3000

export class DebugView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly stackList: HTMLDivElement
  private readonly varTree: HTMLDivElement
  private readonly log: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly status: HTMLDivElement
  private readonly buttons: Record<string, HTMLButtonElement> = {}
  private state: DebugState = 'idle'
  private frames: StackFrame[] = []
  private selectedFrame = 0
  /** Bumped whenever the variables shown become stale (stepping, new frame), so late answers are dropped. */
  private varsGeneration = 0
  private readonly history: string[] = []
  private historyIndex = 0
  private readonly watchList: HTMLDivElement
  private readonly bpList: HTMLDivElement
  private watches: string[] = []
  private threads: { id: number; name: string }[] = []
  private threadId: number | null = null
  private readonly procList: HTMLDivElement

  constructor(private readonly hooks: DebugViewHooks) {
    this.body = div('debug-view')
    const side = div('debug-side')
    this.status = div('debug-status')
    // The program and its child processes (shown when there is more than one).
    this.procList = div('debug-procs')
    this.procList.hidden = true
    const stackHead = div('debug-heading')
    stackHead.textContent = 'Call Stack'
    this.stackList = div('debug-stack')
    this.stackList.setAttribute('role', 'listbox')
    const varHead = div('debug-heading')
    varHead.textContent = 'Variables'
    this.varTree = div('debug-vars')
    this.varTree.setAttribute('role', 'tree')
    // Watch: expressions re-evaluated every time the program pauses.
    const watchHead = div('debug-heading debug-heading-row')
    const watchTitle = document.createElement('span')
    watchTitle.textContent = 'Watch'
    const addWatch = document.createElement('button')
    addWatch.className = 'git-mini'
    addWatch.textContent = '+'
    addWatch.title = 'Add an expression to watch'
    addWatch.addEventListener('click', () => this.startAddWatch())
    watchHead.append(watchTitle, addWatch)
    this.watchList = div('debug-watch')
    // Breakpoints (all files) and exception settings.
    const bpHead = div('debug-heading debug-heading-row')
    const bpTitle = document.createElement('span')
    bpTitle.textContent = 'Breakpoints'
    const mini = (text: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.className = 'git-mini'
      b.textContent = text
      b.title = title
      b.addEventListener('click', fn)
      return b
    }
    bpHead.append(bpTitle,
      mini('☐', 'Switch all breakpoints off', () => hooks.setAllBreakpoints(false)),
      mini('☑', 'Switch all breakpoints on', () => hooks.setAllBreakpoints(true)),
      mini('✕', 'Remove all breakpoints', () => hooks.removeAllBreakpoints()))
    this.bpList = div('debug-bps')
    side.append(this.status, this.procList, stackHead, this.stackList, varHead, this.varTree, watchHead, this.watchList, bpHead, this.bpList)

    const consoleEl = div('debug-console')
    this.log = div('output-log debug-log')
    this.log.setAttribute('role', 'log')
    this.log.tabIndex = 0
    const inputRow = div('output-input-row debug-input-row')
    const prompt = document.createElement('span')
    prompt.textContent = '›'
    this.input = document.createElement('input')
    this.input.className = 'output-input'
    this.input.spellcheck = false
    this.input.setAttribute('aria-label', 'Evaluate expression')
    inputRow.append(prompt, this.input)
    consoleEl.append(this.log, inputRow)
    this.body.append(side, consoleEl)
    this.input.addEventListener('keydown', (e) => this.onInputKey(e))

    this.actions = div('panel-buttons')
    const button = (id: string, label: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('click', fn)
      this.actions.append(b)
      this.buttons[id] = b
    }
    button('continue', '▶ Continue', 'Continue (F5)', () => hooks.continue())
    button('over', '⤼ Over', 'Step Over (F10)', () => hooks.stepOver())
    button('into', '↓ Into', 'Step Into (F11)', () => hooks.stepInto())
    button('out', '↑ Out', 'Step Out (Shift+F11)', () => hooks.stepOut())
    button('restart', '⟳', 'Restart (Ctrl+Shift+F5)', () => hooks.restart())
    button('stop', '■ Stop', 'Stop debugging (Shift+F5)', () => hooks.stop())
    button('clear', 'Clear', 'Clear console', () => this.clearLog())
    this.setState('idle')
  }

  // ---------- session lifecycle ----------

  begin(file: string): void {
    this.clearLog()
    this.append(`🐞 Debugging ${file}\n`, 'meta')
    this.clearPaused()
  }

  started(python: string): void {
    this.append(`using ${python}\n\n`, 'meta')
  }

  setState(state: DebugState): void {
    this.state = state
    const paused = state === 'paused'
    const active = state !== 'idle'
    for (const id of ['continue', 'over', 'into', 'out']) this.buttons[id].disabled = !paused
    this.buttons['stop'].disabled = !active
    this.buttons['restart'].disabled = !active
    this.input.disabled = !paused
    this.input.placeholder = paused
      ? 'Evaluate an expression in the current frame (Enter)'
      : active ? 'Pause at a breakpoint to evaluate expressions' : 'Not debugging. Set a breakpoint (F9) and press F5'
    this.status.dataset.state = state
    if (state === 'running') {
      this.status.textContent = 'Running…'
      this.varsGeneration++
      this.stackList.classList.add('stale')
      this.varTree.classList.add('stale')
    } else if (state === 'starting') {
      this.status.textContent = 'Starting…'
    } else if (state === 'idle') {
      this.status.textContent = 'Not debugging'
    }
    if (state !== 'paused') void this.renderWatches()
  }

  ended(code: number | null): void {
    this.clearPaused()
    const text = code === null ? '\n■ Debugging stopped\n' : `\n${code === 0 ? '✓' : '✗'} Exited with code ${code}\n`
    this.append(text, code === 0 ? 'meta ok' : code === null ? 'meta' : 'meta fail')
  }

  error(message: string): void {
    this.append(message.endsWith('\n') ? message : message + '\n', 'stderr')
  }

  /**
   * The program and its child processes. The shown one is what the call
   * stack, variables, stepping and the console apply to.
   */
  setProcesses(list: { id: number; name: string; state: DebugState }[], shown: number | null): void {
    this.procList.hidden = list.length < 2
    if (this.procList.hidden) return this.procList.replaceChildren()
    const label: Record<DebugState, string> = { idle: 'ended', starting: 'starting', running: 'running', paused: 'paused' }
    this.procList.replaceChildren(...list.map((p) => {
      const row = div('debug-proc' + (p.id === shown ? ' selected' : '') + (p.state === 'paused' ? ' paused' : ''))
      const name = document.createElement('span')
      name.textContent = `${p.id === shown ? '▾' : '▸'} ${p.name}`
      const state = document.createElement('span')
      state.className = 'debug-proc-state'
      state.textContent = label[p.state]
      row.append(name, state)
      row.title = p.id === shown ? 'Shown below (stepping and the console apply to it)' : 'Show this process'
      row.addEventListener('click', () => {
        if (p.id !== shown) this.hooks.selectProcess(p.id)
      })
      return row
    }))
  }

  // ---------- paused: call stack + variables ----------

  showPaused(info: PauseInfo): void {
    this.threads = info.threads
    this.threadId = info.threadId
    this.frames = info.frames
    this.selectedFrame = Math.max(0, info.frames.findIndex((f) => f.path !== null))
    const where = info.frames[this.selectedFrame]
    const reason = info.reason === 'exception' ? 'Paused on exception' : info.reason === 'breakpoint' ? 'Paused on breakpoint' : 'Paused'
    this.status.textContent = where ? `${reason} · ${baseName(where.path)}:${where.line + 1}` : reason
    if (info.description) {
      this.status.textContent += ` · ${info.description}`
      if (info.reason === 'exception') this.append(`\n⚠ ${info.description}\n`, 'stderr')
    }
    this.renderStack()
    void this.loadVariables()
    void this.renderWatches()
  }

  clearPaused(): void {
    this.threads = []
    this.threadId = null
    this.frames = []
    this.varsGeneration++
    this.stackList.replaceChildren()
    this.varTree.replaceChildren()
    this.stackList.classList.remove('stale')
    this.varTree.classList.remove('stale')
  }

  get currentFrame(): StackFrame | undefined {
    return this.frames[this.selectedFrame]
  }

  private renderStack(): void {
    this.stackList.classList.remove('stale')
    // More than one thread: a row per thread above the frames (click to see its stack).
    const threadRows = this.threads.length > 1 ? this.threads.map((t) => {
      const row = div('debug-thread' + (t.id === this.threadId ? ' selected' : ''))
      row.textContent = `${t.id === this.threadId ? '▾' : '▸'} ${t.name}`
      row.title = t.id === this.threadId ? 'This thread (stepping applies to it)' : 'Show this thread'
      row.addEventListener('click', () => {
        if (t.id === this.threadId) return
        void this.hooks.selectThread(t.id).then((frames) => {
          this.threadId = t.id
          this.frames = frames
          this.selectedFrame = Math.max(0, frames.findIndex((f) => f.path !== null))
          this.renderStack()
          void this.loadVariables()
          void this.renderWatches()
          const f = this.currentFrame
          if (f) this.hooks.selectFrame(f)
        }, () => {})
      })
      return row
    }) : []
    this.stackList.replaceChildren(...threadRows, ...this.frames.map((f, i) => {
      const row = div('debug-frame' + (i === this.selectedFrame ? ' selected' : '') + (f.path ? '' : ' no-source'))
      row.setAttribute('role', 'option')
      const name = document.createElement('span')
      name.className = 'debug-frame-name'
      name.textContent = f.name
      const loc = document.createElement('span')
      loc.className = 'debug-frame-loc'
      loc.textContent = f.path ? `${baseName(f.path)}:${f.line + 1}` : ''
      row.title = f.path ? `${f.path}:${f.line + 1}` : f.name
      row.append(name, loc)
      row.addEventListener('click', () => {
        this.selectedFrame = i
        this.renderStack()
        void this.loadVariables()
        void this.renderWatches()
        this.hooks.selectFrame(f)
      })
      return row
    }))
  }

  // ---------- watch expressions ----------

  setWatches(list: string[]): void {
    this.watches = [...list]
    void this.renderWatches()
  }

  private startAddWatch(edit?: number): void {
    const input = document.createElement('input')
    input.className = 'debug-watch-input'
    input.placeholder = 'Expression, e.g. len(items) or user.name'
    input.spellcheck = false
    if (edit !== undefined) input.value = this.watches[edit]
    const done = (save: boolean) => {
      const text = input.value.trim()
      if (save && text) {
        if (edit !== undefined) this.watches[edit] = text
        else this.watches.push(text)
        this.hooks.watchesChanged([...this.watches])
      }
      void this.renderWatches()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') done(true)
      else if (e.key === 'Escape') done(false)
    })
    input.addEventListener('blur', () => done(true))
    if (edit !== undefined) this.watchList.children[edit]?.replaceWith(input)
    else this.watchList.append(input)
    input.focus()
  }

  private watchGeneration = 0

  private async renderWatches(): Promise<void> {
    const gen = ++this.watchGeneration
    const paused = this.state === 'paused'
    const frame = this.currentFrame
    const rows = await Promise.all(this.watches.map(async (expr, i) => {
      let value = paused ? '' : 'not paused'
      let error = false
      let ref = 0
      if (paused) {
        try {
          const r = await this.hooks.watch(expr, frame?.id)
          value = r.result
          ref = r.ref
        } catch (err) {
          value = err instanceof Error ? err.message : String(err)
          error = true
        }
      }
      return { expr, value, error, ref, i }
    }))
    if (gen !== this.watchGeneration) return
    if (!this.watches.length) {
      this.watchList.replaceChildren(message('Click + to watch an expression.'))
      return
    }
    const varGen = this.varsGeneration
    this.watchList.replaceChildren(...rows.map((r) => {
      const wrap = r.ref && !r.error
        ? this.varNode({ name: r.expr, value: r.value, ref: r.ref }, 0, varGen, false)
        : (() => {
            const row = div('debug-var')
            const name = document.createElement('span')
            name.className = 'debug-var-name'
            name.textContent = r.expr
            const val = document.createElement('span')
            val.className = 'debug-var-value' + (r.error || !paused ? ' muted' : '')
            val.textContent = r.value
            row.append(name, document.createTextNode(' = '), val)
            return row
          })()
      wrap.classList.add('debug-watch-row')
      const x = document.createElement('button')
      x.className = 'git-mini debug-watch-remove'
      x.textContent = '×'
      x.title = 'Stop watching'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        this.watches.splice(r.i, 1)
        this.hooks.watchesChanged([...this.watches])
        void this.renderWatches()
      })
      wrap.addEventListener('dblclick', () => this.startAddWatch(r.i))
      wrap.title = 'Double-click to edit'
      wrap.prepend(x)
      return wrap
    }))
  }

  // ---------- breakpoints panel ----------

  /** Redraw the list of breakpoints and exception settings. */
  renderBreakpoints(): void {
    const rows: HTMLElement[] = []
    const { offered, on } = this.hooks.exceptionFilters()
    // Before the first run the adapter hasn't said what it offers: show debugpy's usual two.
    const filters = offered.length ? offered : [
      { filter: 'raised', label: 'Raised Exceptions', default: false },
      { filter: 'uncaught', label: 'Uncaught Exceptions', default: true }
    ]
    for (const f of filters) {
      const label = document.createElement('label')
      label.className = 'debug-bp debug-exc'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = on.includes(f.filter)
      box.addEventListener('change', () => this.hooks.setExceptionFilter(f.filter, box.checked))
      const text = document.createElement('span')
      text.textContent = `Pause on ${f.label.replace(/^./, (c) => c.toLowerCase())}`
      label.append(box, text)
      label.title = f.filter === 'raised' ? 'Stop wherever an exception is raised, even if it is caught later' : 'Stop where an exception would crash the program'
      rows.push(label)
    }
    const bps = this.hooks.breakpoints()
    if (!bps.length) rows.push(message('No breakpoints. Click a line number (or F9) to add one; right-click it for a condition.'))
    for (const b of bps) {
      const row = div('debug-bp' + (b.enabled ? '' : ' off'))
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = b.enabled
      box.title = b.enabled ? 'Switch off' : 'Switch on'
      box.addEventListener('click', (e) => e.stopPropagation())
      box.addEventListener('change', () => this.hooks.setBreakpointEnabled(b, box.checked))
      const where = document.createElement('span')
      where.className = 'debug-bp-where'
      where.textContent = `${baseName(b.path)}:${b.line + 1}`
      const extra = document.createElement('span')
      extra.className = 'debug-bp-extra'
      extra.textContent = [
        b.condition ? `if ${b.condition}` : '',
        b.hitCondition ? `hit ${b.hitCondition}` : '',
        b.logMessage ? `log "${b.logMessage}"` : ''
      ].filter(Boolean).join(' · ')
      const edit = document.createElement('button')
      edit.className = 'git-mini'
      edit.textContent = '✎'
      edit.title = 'Condition, hit count or log message'
      edit.addEventListener('click', (e) => {
        e.stopPropagation()
        this.hooks.editBreakpoint(b)
      })
      const x = document.createElement('button')
      x.className = 'git-mini'
      x.textContent = '×'
      x.title = 'Remove'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        this.hooks.removeBreakpoint(b)
      })
      row.append(box, where, extra, edit, x)
      row.title = `${this.hooks.relative(b.path)}:${b.line + 1}\nClick to go there`
      row.addEventListener('click', () => this.hooks.goToBreakpoint(b))
      rows.push(row)
    }
    this.bpList.replaceChildren(...rows)
  }

  private async loadVariables(): Promise<void> {
    const frame = this.currentFrame
    const gen = ++this.varsGeneration
    if (!frame) return
    try {
      const scopes = await this.hooks.scopes(frame.id)
      if (gen !== this.varsGeneration) return
      this.varTree.classList.remove('stale')
      this.varTree.replaceChildren(...scopes.map((s, i) => {
        // Open the first scope (Locals); bigger ones (Globals) on request.
        return this.varNode({ name: s.name, value: '', ref: s.ref }, 0, gen, i === 0 && !s.expensive, true)
      }))
    } catch (err) {
      if (gen === this.varsGeneration) this.varTree.replaceChildren(message(String(err)))
    }
  }

  private varNode(v: Variable, depth: number, gen: number, open: boolean, isScope = false): HTMLElement {
    const wrap = div('debug-var-wrap')
    const row = div(isScope ? 'debug-var scope' : 'debug-var')
    row.style.paddingLeft = `${6 + depth * 14}px`
    row.setAttribute('role', 'treeitem')
    const chevron = document.createElement('span')
    chevron.className = 'tree-chevron'
    chevron.textContent = v.ref > 0 ? '▸' : ''
    const name = document.createElement('span')
    name.className = 'debug-var-name'
    name.textContent = v.name
    row.append(chevron, name)
    if (!isScope) {
      const eq = document.createElement('span')
      eq.className = 'debug-var-eq'
      eq.textContent = ' = '
      const value = document.createElement('span')
      value.className = 'debug-var-value'
      value.textContent = v.value
      row.append(eq, value)
      row.title = `${v.name}${v.type ? `: ${v.type}` : ''} = ${v.value}`
    }
    wrap.append(row)
    if (v.ref > 0) {
      const children = div('debug-var-children')
      children.hidden = true
      wrap.append(children)
      let loaded = false
      const toggle = async () => {
        children.hidden = !children.hidden
        chevron.textContent = children.hidden ? '▸' : '▾'
        row.setAttribute('aria-expanded', String(!children.hidden))
        if (children.hidden || loaded) return
        loaded = true
        children.replaceChildren(message('…', depth + 1))
        try {
          const vars = await this.hooks.variables(v.ref)
          if (gen !== this.varsGeneration) return
          children.replaceChildren(...(vars.length ? vars.map((c) => this.varNode(c, depth + 1, gen, false)) : [message('(empty)', depth + 1)]))
        } catch (err) {
          children.replaceChildren(message(String(err), depth + 1))
        }
      }
      row.addEventListener('click', () => void toggle())
      if (open) void toggle()
    }
    return wrap
  }

  // ---------- console ----------

  output(category: 'stdout' | 'stderr' | 'console', text: string): void {
    const clean = stripAnsi(text)
    const cls = category === 'stderr' ? 'stderr' : category === 'console' ? 'meta' : ''
    let pos = 0
    for (const link of findFileLinks(clean)) {
      if (link.start > pos) this.append(clean.slice(pos, link.start), cls)
      const a = document.createElement('a')
      a.className = 'file-link ' + cls
      a.textContent = clean.slice(link.start, link.end)
      a.href = '#'
      a.title = 'Open in editor'
      a.addEventListener('click', (e) => {
        e.preventDefault()
        this.hooks.openLink(link.path, link.line)
      })
      this.appendNode(a)
      pos = link.end
    }
    if (pos < clean.length) this.append(clean.slice(pos), cls)
  }

  focusInput(): void {
    if (!this.input.disabled) this.input.focus()
  }

  private async onInputKey(e: KeyboardEvent): Promise<void> {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.history.length) return
      e.preventDefault()
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (e.key === 'ArrowUp' ? -1 : 1)))
      this.input.value = this.history[this.historyIndex] ?? ''
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const expr = this.input.value.trim()
    if (!expr) return
    this.input.value = ''
    if (this.history.at(-1) !== expr) this.history.push(expr)
    this.historyIndex = this.history.length
    this.append(`› ${expr}\n`, 'echo')
    try {
      const { result } = await this.hooks.evaluate(expr)
      this.append(`${result}\n`, 'eval-result')
      // The expression may have changed variables (e.g. x = 5): refresh them.
      void this.loadVariables()
    } catch (err) {
      this.append(`${err instanceof Error ? err.message : String(err)}\n`, 'stderr')
    }
  }

  private append(text: string, className: string): void {
    const span = document.createElement('span')
    if (className) span.className = className
    span.textContent = text
    this.appendNode(span)
  }

  /** Nodes waiting to be added on the next frame (a chatty program would otherwise redraw per write). */
  private pendingNodes: HTMLElement[] = []
  private frame = 0

  private appendNode(node: HTMLElement): void {
    this.pendingNodes.push(node)
    // Far more than is kept is waiting: drop the oldest now.
    if (this.pendingNodes.length > MAX_LOG) this.pendingNodes.splice(0, this.pendingNodes.length - MAX_LOG)
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flushNodes())
  }

  private flushNodes(): void {
    this.frame = 0
    const nodes = this.pendingNodes
    this.pendingNodes = []
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8
    this.log.append(...nodes)
    while (this.log.childElementCount > MAX_LOG) this.log.firstElementChild!.remove()
    if (atBottom) this.log.scrollTop = this.log.scrollHeight
  }

  /** Empty the console, including anything not drawn yet. */
  private clearLog(): void {
    this.pendingNodes = []
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.log.replaceChildren()
  }
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  return d
}

function message(text: string, depth = 0): HTMLElement {
  const m = div('debug-var muted')
  m.style.paddingLeft = `${22 + depth * 14}px`
  m.textContent = text
  return m
}

function baseName(path: string | null): string {
  return path ? path.split(/[\\/]/).pop() ?? path : ''
}
