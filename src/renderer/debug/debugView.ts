/**
 * The Debug panel: step buttons, the call stack, variables (expandable), and
 * a console showing the program's output where you can evaluate expressions
 * while paused.
 */
import { findFileLinks, stripAnsi } from '../../shared/traceback'
import type { DebugState, PauseInfo, StackFrame, Variable } from './session'

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

  constructor(private readonly hooks: DebugViewHooks) {
    this.body = div('debug-view')
    const side = div('debug-side')
    this.status = div('debug-status')
    const stackHead = div('debug-heading')
    stackHead.textContent = 'Call Stack'
    this.stackList = div('debug-stack')
    this.stackList.setAttribute('role', 'listbox')
    const varHead = div('debug-heading')
    varHead.textContent = 'Variables'
    this.varTree = div('debug-vars')
    this.varTree.setAttribute('role', 'tree')
    side.append(this.status, stackHead, this.stackList, varHead, this.varTree)

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
    button('clear', 'Clear', 'Clear console', () => this.log.replaceChildren())
    this.setState('idle')
  }

  // ---------- session lifecycle ----------

  begin(file: string): void {
    this.log.replaceChildren()
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
  }

  ended(code: number | null): void {
    this.clearPaused()
    const text = code === null ? '\n■ Debugging stopped\n' : `\n${code === 0 ? '✓' : '✗'} Exited with code ${code}\n`
    this.append(text, code === 0 ? 'meta ok' : code === null ? 'meta' : 'meta fail')
  }

  error(message: string): void {
    this.append(message.endsWith('\n') ? message : message + '\n', 'stderr')
  }

  // ---------- paused: call stack + variables ----------

  showPaused(info: PauseInfo): void {
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
  }

  clearPaused(): void {
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
    this.stackList.replaceChildren(...this.frames.map((f, i) => {
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
        this.hooks.selectFrame(f)
      })
      return row
    }))
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

  private appendNode(node: HTMLElement): void {
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8
    this.log.append(node)
    while (this.log.childElementCount > MAX_LOG) this.log.firstElementChild!.remove()
    if (atBottom) this.log.scrollTop = this.log.scrollHeight
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
