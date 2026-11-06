/**
 * The Output view: shows what a running Python program prints.
 * stderr is red, traceback locations are clickable, and while the program
 * runs an input box sends lines to its stdin (so input() works).
 */
import { findFileLinks, stripAnsi } from '../shared/traceback'
import { countLines, lastLines } from '../shared/outputBuffer'

/** Lines kept on screen; older ones are removed (with a note saying how many). */
const MAX_LINES = 20_000
/** Output waiting to be drawn beyond this is dropped, oldest first. */
const MAX_WAITING_CHARS = 2_000_000

interface Waiting {
  text: string
  cls: string
  /** Program output: look for traceback locations to turn into links. */
  links: boolean
}

export class OutputView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly log: HTMLDivElement
  private readonly inputRow: HTMLDivElement
  private readonly input: HTMLInputElement
  /** Says how many old lines were removed (always the log's first child). */
  private readonly trimNote: HTMLDivElement
  private running = false
  /** Output not drawn yet: drawn together on the next animation frame. */
  private waiting: Waiting[] = []
  private waitingChars = 0
  /** Lines dropped from `waiting` before they could be drawn. */
  private waitingDropped = 0
  private frame = 0
  /** Lines on screen, and how many each element holds (to remove old ones). */
  private shownLines = 0
  private readonly nodeLines = new WeakMap<Node, number>()
  private trimmedLines = 0

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
    this.trimNote = document.createElement('div')
    this.trimNote.className = 'output-trimmed'
    this.trimNote.hidden = true
    this.log.append(this.trimNote)
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
    button('■ Stop', 'Stop (Shift+F5)', () => {
      actions.stop()
      this.discardWaiting()
    })
    button('Clear', 'Clear output', () => this.clear())
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Output is still waiting to be drawn. */
  get hasWaiting(): boolean {
    return this.waiting.length > 0
  }

  clear(): void {
    this.waiting = []
    this.waitingChars = 0
    this.waitingDropped = 0
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.shownLines = 0
    this.trimmedLines = 0
    this.trimNote.hidden = true
    this.trimNote.textContent = ''
    this.log.replaceChildren(this.trimNote)
  }

  /** Throw away output that hasn't been drawn yet (Stop pressed while a flood is still arriving). */
  discardWaiting(): void {
    const lines = this.waiting.reduce((n, w) => n + countLines(w.text), 0) + this.waitingDropped
    this.waiting = []
    this.waitingChars = 0
    this.waitingDropped = 0
    if (lines) this.queue(`[… ${lines.toLocaleString('en-US')} lines of output not shown (stopped) …]\n`, 'meta', false)
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
    this.queue(text, stream === 'stderr' ? 'stderr' : '', true)
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
    this.queue(text, className, false)
  }

  /** Add text to draw on the next frame (everything goes through here, so order is kept). */
  private queue(text: string, cls: string, links: boolean): void {
    if (!text) return
    const last = this.waiting[this.waiting.length - 1]
    if (last && last.cls === cls && last.links === links) last.text += text
    else this.waiting.push({ text, cls, links })
    this.waitingChars += text.length
    // Far more than fits on screen is waiting: drop the oldest (it would be removed anyway).
    while (this.waitingChars > MAX_WAITING_CHARS && this.waiting.length > 1) {
      const old = this.waiting.shift()!
      this.waitingChars -= old.text.length
      this.waitingDropped += countLines(old.text)
    }
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw())
  }

  /** Draw everything waiting at once, then remove old lines beyond MAX_LINES. */
  private draw(): void {
    this.frame = 0
    const items = this.waiting
    this.waiting = []
    this.waitingChars = 0
    // Stick to the bottom only if the user hasn't scrolled up to read something.
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8
    const frag = document.createDocumentFragment()
    if (this.waitingDropped) {
      this.trimmedLines += this.waitingDropped
      this.waitingDropped = 0
    }
    for (const item of items) {
      // A single piece longer than the screen keeps only its end.
      const { text, cut } = lastLines(item.links ? stripAnsi(item.text) : item.text, MAX_LINES)
      this.trimmedLines += cut
      if (item.links) this.addLinked(frag, text, item.cls)
      else this.addSpan(frag, text, item.cls)
    }
    this.log.append(frag)
    // Remove the oldest elements while there are too many lines.
    while (this.shownLines > MAX_LINES && this.log.childElementCount > 1) {
      const oldest = this.trimNote.nextSibling
      if (!oldest) break
      const n = this.nodeLines.get(oldest) ?? 0
      oldest.remove()
      this.shownLines -= n
      this.trimmedLines += n
    }
    this.trimNote.hidden = this.trimmedLines === 0
    if (this.trimmedLines) this.trimNote.textContent = `… ${this.trimmedLines.toLocaleString('en-US')} earlier lines not shown (only the last ${MAX_LINES.toLocaleString('en-US')} are kept)`
    if (atBottom) this.log.scrollTop = this.log.scrollHeight
  }

  private addSpan(parent: Node, text: string, cls: string): void {
    if (!text) return
    const span = document.createElement('span')
    if (cls) span.className = cls
    span.textContent = text // textContent: program output is never parsed as HTML
    const n = countLines(text)
    this.nodeLines.set(span, n)
    this.shownLines += n
    parent.appendChild(span)
  }

  /** Program output, with traceback locations ("File ..., line N") turned into links. */
  private addLinked(parent: Node, text: string, cls: string): void {
    // Only search for links in text that could contain them (cheap check first).
    const links = text.includes('File "') ? findFileLinks(text) : []
    let pos = 0
    for (const link of links) {
      if (link.start > pos) this.addSpan(parent, text.slice(pos, link.start), cls)
      const a = document.createElement('a')
      a.className = 'file-link ' + cls
      a.textContent = text.slice(link.start, link.end)
      a.title = 'Open in editor'
      a.href = '#'
      a.addEventListener('click', (e) => {
        e.preventDefault()
        this.onOpenLink(link.path, link.line)
      })
      parent.appendChild(a)
      pos = link.end
    }
    if (pos < text.length) this.addSpan(parent, text.slice(pos), cls)
  }
}
