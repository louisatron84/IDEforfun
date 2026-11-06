/**
 * The integrated terminal (bottom panel → Terminal, or Ctrl+`).
 * xterm.js draws it; a real shell runs in the main process via node-pty.
 * There can be several terminals, each with its own shell; a list on the
 * right switches between them.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ShellProfile, TerminalEvent } from '../shared/api'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function theme() {
  return {
    background: cssVar('--bg'),
    foreground: cssVar('--fg'),
    cursor: cssVar('--fg'),
    selectionBackground: cssVar('--selection')
  }
}

/** One terminal: an xterm.js screen connected to one shell process. */
class TerminalSession {
  readonly el: HTMLDivElement
  readonly term: Terminal
  private readonly fit = new FitAddon()
  ptyId: number | null = null
  /** A name to show instead of the shell's (e.g. the task it runs). */
  label: string | null = null
  /** Runs this program instead of a shell (e.g. the program being debugged); it isn't restarted. */
  program: { args: string[]; env: Record<string, string | null> } | null = null
  pid: number | null = null
  private starting = false
  private exited = false

  constructor(
    readonly number: number,
    readonly profile: ShellProfile | null,
    private readonly getCwd: () => string | null,
    private readonly onTitle: () => void
  ) {
    this.el = document.createElement('div')
    this.el.className = 'terminal-session'
    this.term = new Terminal({
      fontFamily: cssVar('--font-code'),
      fontSize: parseFloat(cssVar('--code-size')) || 14,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: theme()
    })
    this.term.loadAddon(this.fit)
    this.term.open(this.el)
    this.term.onData((data) => {
      if (this.exited && this.program) return // a finished program isn't restarted
      if (this.exited) {
        // Any key after the shell exited starts a new one.
        this.exited = false
        this.term.clear()
        void this.start()
        return
      }
      if (this.ptyId !== null) window.api.terminalWrite(this.ptyId, data)
    })
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId !== null) window.api.terminalResize(this.ptyId, cols, rows)
    })
    this.term.onTitleChange(() => this.onTitle())
    // Copy/paste like other Windows terminals: Ctrl+C copies when text is
    // selected (otherwise it interrupts the program), Ctrl+V pastes.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && key === 'c' && (e.shiftKey || this.term.hasSelection())) {
        void navigator.clipboard.writeText(this.term.getSelection())
        this.term.clearSelection()
        return false
      }
      if (ctrl && key === 'v') return false // let the browser fire a paste event, which xterm handles
      return true
    })
  }

  get name(): string {
    return this.label ?? this.profile?.name ?? 'Terminal'
  }

  handle(e: TerminalEvent): void {
    if (e.type === 'data') this.term.write(e.data)
    else {
      this.exited = true
      this.ptyId = null
      this.term.write(this.program
        ? `\r\n\x1b[90m[program exited with code ${e.code}]\x1b[0m\r\n`
        : `\r\n\x1b[90m[shell exited with code ${e.code}: press any key to start a new one]\x1b[0m\r\n`)
    }
  }

  async start(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      this.layout()
      if (this.program) {
        const r = await window.api.terminalRun(this.program.args, this.getCwd(), this.program.env, this.term.cols, this.term.rows)
        this.ptyId = r.id
        this.pid = r.pid
      } else {
        this.ptyId = await window.api.terminalCreate(this.getCwd(), this.term.cols, this.term.rows, this.profile?.id)
      }
    } catch (err) {
      this.term.write(`\x1b[31mCould not start a shell: ${String(err)}\x1b[0m\r\n`)
    } finally {
      this.starting = false
    }
  }

  async restart(): Promise<void> {
    this.kill()
    this.exited = false
    this.term.reset()
    await this.start()
    this.term.focus()
  }

  kill(): void {
    if (this.ptyId !== null) window.api.terminalKill(this.ptyId)
    this.ptyId = null
  }

  dispose(): void {
    this.kill()
    this.term.dispose()
    this.el.remove()
  }

  layout(): void {
    if (this.el.offsetParent === null) return // hidden: nothing to measure
    try {
      this.fit.fit()
    } catch {
      // not laid out yet
    }
  }

  applyTheme(fontSize: number): void {
    this.term.options.fontSize = fontSize
    this.term.options.fontFamily = cssVar('--font-code')
    this.term.options.theme = theme()
    this.layout()
  }
}

export class TerminalView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly screens: HTMLDivElement
  private readonly list: HTMLDivElement
  private readonly sessions: TerminalSession[] = []
  private active: TerminalSession | null = null
  private nextNumber = 1
  private shells: ShellProfile[] | null = null
  private fontSize: number | null = null
  /** Shells of the terminals open last session, started when the panel is first shown. */
  private pending: string[] = []

  constructor(
    private readonly getCwd: () => string | null,
    /** Ask the user to pick a shell (e.g. with the palette). */
    private readonly pickShell: (shells: ShellProfile[], pick: (shell: ShellProfile) => void) => void,
    /** The shell id new terminals use by default ('' = the system default). */
    private readonly defaultShellId: () => string
  ) {
    this.body = document.createElement('div')
    this.body.className = 'terminal-view'
    this.screens = document.createElement('div')
    this.screens.className = 'terminal-screens'
    this.list = document.createElement('div')
    this.list.className = 'terminal-list'
    this.list.setAttribute('role', 'tablist')
    this.list.setAttribute('aria-label', 'Terminals')
    this.body.append(this.screens, this.list)

    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    const button = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('click', fn)
      this.actions.append(b)
    }
    button('+', 'New terminal (Ctrl+Shift+`)', () => void this.newTerminal())
    button('▾', 'New terminal with a shell of your choice…', () => void this.newTerminalWithShell())
    button('↻', 'Restart this terminal', () => void this.active?.restart())
    button('🗑', 'Kill this terminal', () => this.killActive())
    button('Clear', 'Clear this terminal', () => this.active?.term.clear())

    window.api.onTerminalEvent((e) => this.sessions.find((s) => s.ptyId === e.id)?.handle(e))
    // Refit whenever the panel is resized.
    new ResizeObserver(() => this.active?.layout()).observe(this.body)
  }

  /** Called when the Terminal tab becomes visible: create a terminal on first use. */
  show(): void {
    if (!this.sessions.length) {
      void this.startPending()
      return
    }
    this.active?.layout()
    this.active?.term.focus()
  }

  focus(): void {
    this.active?.term.focus()
  }

  /** The shell id of each terminal ('' = default), to reopen them next time. */
  shellIds(): string[] {
    return this.sessions.length ? this.sessions.map((s) => s.profile?.id ?? '') : [...this.pending]
  }

  /** Terminals to open (with these shells) when the panel is next shown, if none are open. */
  setPending(shellIds: string[]): void {
    if (!this.sessions.length) this.pending = [...shellIds]
  }

  private startingPending = false

  private async startPending(): Promise<void> {
    if (this.startingPending) return // shown twice quickly
    this.startingPending = true
    try {
      const ids = this.pending.length ? this.pending : ['']
      this.pending = []
      const shells = await this.loadShells()
      for (const id of ids) await this.newTerminal(shells.find((s) => s.id === id))
    } finally {
      this.startingPending = false
    }
  }

  get hasFocus(): boolean {
    return this.body.contains(document.activeElement)
  }

  /** Re-apply font and colors (after a settings change). */
  applyTheme(fontSize: number): void {
    this.fontSize = fontSize
    for (const s of this.sessions) s.applyTheme(fontSize)
  }

  private async loadShells(): Promise<ShellProfile[]> {
    if (!this.shells) {
      try {
        this.shells = await window.api.terminalShells()
      } catch {
        this.shells = []
      }
    }
    return this.shells
  }

  /** Open a new terminal (the default shell unless one is given). */
  async newTerminal(profile?: ShellProfile, opts: { cwd?: string; label?: string; program?: { args: string[]; env: Record<string, string | null> } } = {}): Promise<TerminalSession> {
    const shells = await this.loadShells()
    const chosen = profile ?? shells.find((s) => s.id === this.defaultShellId()) ?? shells[0] ?? null
    const getCwd = opts.cwd ? () => opts.cwd! : this.getCwd
    const session = new TerminalSession(this.nextNumber++, chosen, getCwd, () => this.renderList())
    if (opts.label) session.label = opts.label
    if (opts.program) session.program = opts.program
    if (this.fontSize !== null) session.applyTheme(this.fontSize)
    this.sessions.push(session)
    this.screens.append(session.el)
    this.activate(session)
    await session.start()
    return session
  }

  /**
   * Run a command (a task) in a new terminal named after it, in `cwd`. The
   * terminal stays open afterwards so you can read the output or run it again.
   */
  async runCommand(label: string, command: string, cwd: string): Promise<void> {
    const session = await this.newTerminal(undefined, { cwd, label })
    if (session.ptyId !== null) window.api.terminalWrite(session.ptyId, command + '\r')
  }

  /**
   * Run a program in a new terminal (the debugger asks for this so the
   * program can read the keyboard). Returns its process id.
   */
  async runProgram(label: string, args: string[], cwd: string, env: Record<string, string | null>): Promise<number | undefined> {
    const session = await this.newTerminal(undefined, { cwd, label, program: { args, env } })
    return session.pid ?? undefined
  }

  async newTerminalWithShell(): Promise<void> {
    const shells = await this.loadShells()
    this.pickShell(shells, (shell) => void this.newTerminal(shell))
  }

  killActive(): void {
    const s = this.active
    if (!s) return
    const i = this.sessions.indexOf(s)
    this.sessions.splice(i, 1)
    s.dispose()
    this.active = null
    const next = this.sessions[Math.min(i, this.sessions.length - 1)]
    if (next) this.activate(next)
    else this.renderList()
  }

  /** Switch to the next terminal (wrapping around). */
  next(): void {
    if (this.sessions.length < 2 || !this.active) return
    const i = this.sessions.indexOf(this.active)
    this.activate(this.sessions[(i + 1) % this.sessions.length])
  }

  private activate(session: TerminalSession): void {
    this.active = session
    for (const s of this.sessions) s.el.hidden = s !== session
    this.renderList()
    requestAnimationFrame(() => {
      session.layout()
      session.term.focus()
    })
  }

  private renderList(): void {
    // The list only appears once there's more than one terminal.
    this.list.hidden = this.sessions.length < 2
    this.list.replaceChildren(...this.sessions.map((s) => {
      const row = document.createElement('div')
      row.className = 'terminal-list-item' + (s === this.active ? ' active' : '')
      row.setAttribute('role', 'tab')
      row.setAttribute('aria-selected', String(s === this.active))
      row.textContent = `${s.number}: ${s.name}`
      row.title = s.profile?.file ?? s.name
      row.addEventListener('click', () => this.activate(s))
      return row
    }))
  }
}
