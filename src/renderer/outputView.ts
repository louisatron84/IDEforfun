/**
 * The Output view: shows what a running Python program prints.
 * stderr is red, traceback locations are clickable, and while the program
 * runs an input box sends lines to its stdin (so input() works).
 */
import { findFileLinks, stripAnsi } from '../shared/traceback'

/** Keep the DOM small for programs that print a lot. */
const MAX_CHUNKS = 3000

export class OutputView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly log: HTMLDivElement
  private readonly inputRow: HTMLDivElement
  private readonly input: HTMLInputElement
  private running = false

  constructor(
    private readonly onOpenLink: (path: string, line: number) => void,
    private readonly onSendInput: (text: string) => void,
    actions: { run: () => void; stop: () => void }
  ) {
    this.body = document.createElement('div')
    this.body.className = 'output-view'
    this.log = document.createElement('div')
    this.log.className = 'output-log'
    this.log.setAttribute('role', 'log')
    this.log.tabIndex = 0
    this.inputRow = document.createElement('div')
    this.inputRow.className = 'output-input-row'
    this.inputRow.hidden = true
    const prompt = document.createElement('span')
    prompt.textContent = 'Input ›'
    this.input = document.createElement('input')
    this.input.className = 'output-input'
    this.input.placeholder = 'Type here and press Enter to send to the program'
    this.input.setAttribute('aria-label', 'Program input')
    this.input.spellcheck = false
    this.inputRow.append(prompt, this.input)
    this.body.append(this.log, this.inputRow)

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const text = this.input.value
      this.input.value = ''
      this.appendSpan(text + '\n', 'echo') // show what was typed, like a terminal would
      this.onSendInput(text + '\n')
    })

    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    const button = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.addEventListener('click', fn)
      this.actions.append(b)
      return b
    }
    button('▶ Run', 'Run current file (F5)', actions.run)
    button('■ Stop', 'Stop (Shift+F5)', actions.stop)
    button('Clear', 'Clear output', () => this.clear())
  }

  get isRunning(): boolean {
    return this.running
  }

  clear(): void {
    this.log.replaceChildren()
  }

  /** A run is about to start: clear old output and show what's running. */
  begin(file: string): void {
    this.clear()
    this.appendSpan(`▶ ${file}\n`, 'meta')
  }

  started(python: string): void {
    this.running = true
    this.inputRow.hidden = false
    this.appendSpan(`using ${python}\n\n`, 'meta')
  }

  append(stream: 'stdout' | 'stderr', text: string): void {
    const clean = stripAnsi(text)
    const cls = stream === 'stderr' ? 'stderr' : ''
    // Split the chunk around traceback locations so those become links.
    let pos = 0
    for (const link of findFileLinks(clean)) {
      if (link.start > pos) this.appendSpan(clean.slice(pos, link.start), cls)
      const a = document.createElement('a')
      a.className = 'file-link ' + cls
      a.textContent = clean.slice(link.start, link.end)
      a.title = 'Open in editor'
      a.href = '#'
      a.addEventListener('click', (e) => {
        e.preventDefault()
        this.onOpenLink(link.path, link.line)
      })
      this.appendNode(a)
      pos = link.end
    }
    if (pos < clean.length) this.appendSpan(clean.slice(pos), cls)
  }

  error(message: string): void {
    this.appendSpan(message + '\n', 'stderr')
  }

  finished(code: number | null, ms: number, signal?: string): void {
    this.running = false
    this.inputRow.hidden = true
    const secs = (ms / 1000).toFixed(2)
    const text = signal || code === null
      ? `\n■ Stopped after ${secs}s\n`
      : `\n${code === 0 ? '✓' : '✗'} Exited with code ${code} in ${secs}s\n`
    this.appendSpan(text, code === 0 ? 'meta ok' : 'meta fail')
  }

  focusInput(): void {
    if (!this.inputRow.hidden) this.input.focus()
  }

  private appendSpan(text: string, className: string): void {
    const span = document.createElement('span')
    if (className) span.className = className
    span.textContent = text // textContent: program output is never parsed as HTML
    this.appendNode(span)
  }

  private appendNode(node: HTMLElement): void {
    // Stick to the bottom only if the user hasn't scrolled up to read something.
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8
    this.log.append(node)
    while (this.log.childElementCount > MAX_CHUNKS) this.log.firstElementChild!.remove()
    if (atBottom) this.log.scrollTop = this.log.scrollHeight
  }
}
