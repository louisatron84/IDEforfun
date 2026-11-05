/**
 * The integrated terminal (bottom panel → Terminal, or Ctrl+`).
 * xterm.js draws it; a real shell runs in the main process via node-pty.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export class TerminalView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private term: Terminal | null = null
  private fit = new FitAddon()
  private ptyId: number | null = null
  private starting = false
  private exited = false

  constructor(private readonly getCwd: () => string | null) {
    this.body = document.createElement('div')
    this.body.className = 'terminal-view'

    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    const restart = document.createElement('button')
    restart.textContent = '↻ Restart'
    restart.title = 'Kill the shell and start a new one'
    restart.addEventListener('click', () => void this.restart())
    const clear = document.createElement('button')
    clear.textContent = 'Clear'
    clear.addEventListener('click', () => this.term?.clear())
    this.actions.append(restart, clear)

    window.api.onTerminalEvent((e) => {
      if (e.id !== this.ptyId) return
      if (e.type === 'data') this.term?.write(e.data)
      else {
        this.exited = true
        this.ptyId = null
        this.term?.write(`\r\n\x1b[90m[shell exited with code ${e.code} — press any key to start a new one]\x1b[0m\r\n`)
      }
    })

    // Refit whenever the panel is resized.
    new ResizeObserver(() => this.layout()).observe(this.body)
  }

  /** Called when the Terminal tab becomes visible: create the shell on first use. */
  show(): void {
    if (!this.term) this.createTerminal()
    this.layout()
    if (this.ptyId === null && !this.exited) void this.startShell()
    this.term!.focus()
  }

  focus(): void {
    this.term?.focus()
  }

  get hasFocus(): boolean {
    return this.body.contains(document.activeElement)
  }

  /** Re-apply font and colors (after a settings change). */
  applyTheme(fontSize: number): void {
    if (!this.term) return
    this.term.options.fontSize = fontSize
    this.term.options.theme = this.theme()
    this.layout()
  }

  private theme() {
    return {
      background: cssVar('--bg'),
      foreground: cssVar('--fg'),
      cursor: cssVar('--fg'),
      selectionBackground: cssVar('--selection')
    }
  }

  private createTerminal(): void {
    const term = new Terminal({
      fontFamily: cssVar('--font-code'),
      fontSize: parseFloat(cssVar('--code-size')) || 14,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: this.theme()
    })
    term.loadAddon(this.fit)
    term.open(this.body)

    term.onData((data) => {
      if (this.exited) {
        // Any key after the shell exited starts a new one.
        this.exited = false
        term.clear()
        void this.startShell()
        return
      }
      if (this.ptyId !== null) window.api.terminalWrite(this.ptyId, data)
    })
    term.onResize(({ cols, rows }) => {
      if (this.ptyId !== null) window.api.terminalResize(this.ptyId, cols, rows)
    })

    // Copy/paste like other Windows terminals: Ctrl+C copies when text is
    // selected (otherwise it interrupts the program), Ctrl+V pastes.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && key === 'c' && (e.shiftKey || term.hasSelection())) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (ctrl && key === 'v') return false // let the browser fire a paste event, which xterm handles
      return true
    })
    this.term = term
  }

  private async startShell(): Promise<void> {
    if (this.starting || !this.term) return
    this.starting = true
    try {
      this.layout()
      this.ptyId = await window.api.terminalCreate(this.getCwd(), this.term.cols, this.term.rows)
    } catch (err) {
      this.term.write(`\x1b[31mCould not start a shell: ${String(err)}\x1b[0m\r\n`)
    } finally {
      this.starting = false
    }
  }

  private async restart(): Promise<void> {
    if (this.ptyId !== null) window.api.terminalKill(this.ptyId)
    this.ptyId = null
    this.exited = false
    this.term?.reset()
    await this.startShell()
    this.term?.focus()
  }

  private layout(): void {
    if (!this.term || this.body.offsetParent === null) return // hidden: nothing to measure
    try {
      this.fit.fit()
    } catch {
      // not laid out yet
    }
  }
}
