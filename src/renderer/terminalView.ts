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
    return this.profile?.name ?? 'Terminal'
  }

  handle(e: TerminalEvent): void {
    if (e.type === 'data') this.term.write(e.data)
    else {
      this.exited = true
      this.ptyId = null
      this.term.write(`\r\n\x1b[90m[shell exited with code ${e.code}: press any key to start a new one]\x1b[0m\r\n`)
    }
  }

  async start(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      this.layout()
      this.ptyId = await window.api.terminalCreate(this.getCwd(), this.term.cols, this.term.rows, this.profile?.id)
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
      void this.newTerminal()
      return
    }
    this.active?.layout()
    this.active?.term.focus()
  }

  focus(): void {
    this.active?.term.focus()
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
  async newTerminal(profile?: ShellProfile): Promise<void> {
    const shells = await this.loadShells()
    const chosen = profile ?? shells.find((s) => s.id === this.defaultShellId()) ?? shells[0] ?? null
    const session = new TerminalSession(this.nextNumber++, chosen, this.getCwd, () => this.renderList())
    if (this.fontSize !== null) session.applyTheme(this.fontSize)
    this.sessions.push(session)
    this.screens.append(session.el)
    this.activate(session)
    await session.start()
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
