/**
 * The command palette. One input, three modes chosen by the first character:
 *   ">"  commands      (Ctrl+Shift+P)
 *   ":"  go to line    (Ctrl+G)
 *   else quick open a file in the project (Ctrl+P)
 * Arrow keys move, Enter picks, Escape closes.
 */
import { keyString, type CommandRegistry } from './keymap'
import { fuzzyFilter } from './fuzzy'

interface Item {
  label: string
  /** Characters of `label` to show bold (fuzzy match positions). */
  positions: number[]
  detail?: string
  hint?: string
  run: () => void
}

export interface PaletteDeps {
  commands: CommandRegistry
  listFiles: () => Promise<{ path: string; rel: string }[]>
  openFile: (path: string) => void
  goToLine: (line: number) => void
  lineCount: () => number | null
}

const MAX_ITEMS = 60

export class Palette {
  private readonly overlay: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLDivElement
  private items: Item[] = []
  private selected = 0
  private files: { path: string; rel: string }[] = []
  private returnFocus: HTMLElement | null = null
  /** When set, the palette shows these choices instead of files/commands. */
  private choices: { label: string; detail?: string; hint?: string; run: () => void }[] | null = null
  private choicePrompt = ''
  /** In prompt mode: what to do with the typed text. */
  private textSubmit: ((text: string) => void) | null = null
  /** In key-capture mode: what to do with the next shortcut pressed. */
  private keyCapture: ((key: string) => void) | null = null
  /** The action word shown in prompt mode ("Open", "Install"...). */
  private promptVerb = 'Open'

  constructor(private readonly deps: PaletteDeps) {
    this.overlay = document.createElement('div')
    this.overlay.className = 'overlay palette-overlay'
    this.overlay.hidden = true
    const box = document.createElement('div')
    box.className = 'palette'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', 'Command palette')
    this.input = document.createElement('input')
    this.input.className = 'palette-input'
    this.input.spellcheck = false
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-controls', 'palette-list')
    this.input.setAttribute('aria-expanded', 'true')
    this.list = document.createElement('div')
    this.list.className = 'palette-list'
    this.list.id = 'palette-list'
    this.list.setAttribute('role', 'listbox')
    box.append(this.input, this.list)
    this.overlay.append(box)
    document.body.append(this.overlay)

    this.input.addEventListener('input', () => this.update())
    this.input.addEventListener('keydown', (e) => this.onKey(e))
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close()
    })
  }

  get isOpen(): boolean {
    return !this.overlay.hidden
  }

  /** True while waiting for a shortcut to be pressed (every key goes to the palette). */
  get capturing(): boolean {
    return this.isOpen && this.keyCapture !== null
  }

  /** Wait for a shortcut to be pressed (to change a command's keys); Escape cancels. */
  captureKey(prompt: string, onKey: (key: string) => void): void {
    this.choose(prompt, [])
    this.keyCapture = onKey
    this.input.readOnly = true
    this.update()
  }

  private stopCapture(): void {
    this.keyCapture = null
    this.input.readOnly = false
    this.searchProvider = null
  }

  /** In search mode: asked for results as you type (e.g. symbols across the project). */
  private searchProvider: ((query: string) => Promise<{ label: string; detail?: string; hint?: string; run: () => void }[]>) | null = null
  private searchTimer: number | undefined
  private searchGeneration = 0

  /** Choices that come from a search as you type (the provider does the filtering). */
  search(prompt: string, provider: (query: string) => Promise<{ label: string; detail?: string; hint?: string; run: () => void }[]>, initial = ''): void {
    this.choose(prompt, [])
    this.searchProvider = provider
    this.input.value = initial
    this.input.select()
    this.update()
  }

  private runSearch(query: string): void {
    const provider = this.searchProvider!
    window.clearTimeout(this.searchTimer)
    const gen = ++this.searchGeneration
    this.items = [{ label: query ? 'Searching…' : 'Type a name to search for', positions: [], run: () => {} }]
    this.selected = 0
    this.input.placeholder = this.choicePrompt
    this.renderList()
    if (!query) return
    this.searchTimer = window.setTimeout(() => {
      void provider(query).then((results) => {
        if (gen !== this.searchGeneration || this.searchProvider !== provider || !this.isOpen) return
        this.items = results.length
          ? results.slice(0, MAX_ITEMS).map((r) => ({ label: r.label, positions: [], detail: r.detail, hint: r.hint, run: r.run }))
          : [{ label: `Nothing called "${query}" found`, positions: [], run: () => {} }]
        this.selected = 0
        this.renderList()
      }).catch(() => {})
    }, 180)
  }

  /** Ask for a line of text (e.g. a folder path); Enter calls `submit` with it. */
  prompt(placeholder: string, submit: (text: string) => void, initial = '', verb = 'Open'): void {
    this.choose(placeholder, [])
    this.textSubmit = submit
    this.promptVerb = verb
    this.input.value = initial
    this.update()
  }

  /** Show a list of choices (e.g. encodings); picking one runs it. */
  choose(prompt: string, choices: { label: string; detail?: string; hint?: string; run: () => void }[]): void {
    if (!this.isOpen) this.returnFocus = document.activeElement as HTMLElement | null
    this.textSubmit = null
    this.stopCapture()
    this.choices = choices
    this.choicePrompt = prompt
    this.overlay.hidden = false
    this.input.value = ''
    this.input.focus()
    this.update()
  }

  /** Open with an initial prefix: '>' commands, ':' go to line, '' files. */
  async open(prefix: '>' | ':' | ''): Promise<void> {
    this.choices = null
    this.textSubmit = null
    this.stopCapture()
    if (!this.isOpen) this.returnFocus = document.activeElement as HTMLElement | null
    this.overlay.hidden = false
    this.input.value = prefix
    this.input.focus()
    this.update()
    if (prefix === '') {
      this.files = await this.deps.listFiles()
      if (this.isOpen && !this.input.value.startsWith('>') && !this.input.value.startsWith(':')) this.update()
    }
  }

  close(): void {
    if (!this.isOpen) return
    this.overlay.hidden = true
    this.choices = null
    this.textSubmit = null
    this.stopCapture()
    this.returnFocus?.focus()
  }

  private update(): void {
    const value = this.input.value
    if (this.searchProvider) {
      this.runSearch(value.trim())
      return
    }
    if (this.keyCapture) {
      this.items = [{ label: 'Press the new shortcut now (Escape cancels)', positions: [], run: () => {} }]
      this.selected = 0
      this.input.placeholder = this.choicePrompt
      this.renderList()
      return
    }
    if (this.textSubmit) {
      const submit = this.textSubmit
      const text = value.trim()
      this.items = [{ label: text ? `${this.promptVerb} "${text}"` : 'Type here and press Enter', positions: [], run: () => { if (text) submit(text) } }]
      this.selected = 0
      this.input.placeholder = this.choicePrompt
      this.renderList()
      return
    }
    if (this.choices) {
      this.items = fuzzyFilter(value.trim(), this.choices, (c) => c.label, MAX_ITEMS).map(({ item, match }) => ({
        label: item.label, positions: match.positions, detail: item.detail, hint: item.hint, run: item.run
      }))
      this.selected = 0
      this.input.placeholder = this.choicePrompt
      this.renderList()
      return
    }
    if (value.startsWith('>')) this.items = this.commandItems(value.slice(1).trim())
    else if (value.startsWith(':')) this.items = this.lineItems(value.slice(1).trim())
    else this.items = this.fileItems(value.trim())
    this.selected = 0
    this.input.placeholder = 'Search files by name (type > for commands, : for a line number)'
    this.renderList()
  }

  private commandItems(query: string): Item[] {
    const commands = this.deps.commands.available()
    return fuzzyFilter(query, commands, (c) => c.title, MAX_ITEMS).map(({ item, match }) => ({
      label: item.title,
      positions: match.positions,
      hint: this.deps.commands.keysOf(item.id)[0],
      run: () => this.deps.commands.run(item.id)
    }))
  }

  private fileItems(query: string): Item[] {
    if (this.files.length === 0) return []
    return fuzzyFilter(query, this.files, (f) => f.rel, MAX_ITEMS).map(({ item, match }) => {
      const slash = item.rel.lastIndexOf('/')
      const name = item.rel.slice(slash + 1)
      return {
        label: name,
        positions: match.positions.filter((p) => p > slash).map((p) => p - slash - 1),
        detail: slash > 0 ? item.rel.slice(0, slash) : undefined,
        run: () => this.deps.openFile(item.path)
      }
    })
  }

  private lineItems(query: string): Item[] {
    const total = this.deps.lineCount()
    if (total === null) return [{ label: 'Open a file first', positions: [], run: () => {} }]
    const n = Number.parseInt(query, 10)
    if (!query || Number.isNaN(n)) {
      return [{ label: `Type a line number between 1 and ${total}`, positions: [], run: () => {} }]
    }
    const line = Math.min(Math.max(n, 1), total)
    return [{ label: `Go to line ${line}`, positions: [], hint: `of ${total}`, run: () => this.deps.goToLine(line - 1) }]
  }

  private renderList(): void {
    const rows = this.items.map((item, i) => {
      const row = document.createElement('div')
      row.className = 'palette-item'
      row.id = `palette-item-${i}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === this.selected))
      const label = document.createElement('span')
      label.className = 'palette-label'
      // Bold the matched characters (built with text nodes, never innerHTML).
      const marks = new Set(item.positions)
      let run = ''
      let bold = false
      const flush = () => {
        if (!run) return
        if (bold) {
          const b = document.createElement('b')
          b.textContent = run
          label.append(b)
        } else label.append(run)
        run = ''
      }
      for (let c = 0; c < item.label.length; c++) {
        const isMark = marks.has(c)
        if (isMark !== bold) {
          flush()
          bold = isMark
        }
        run += item.label[c]
      }
      flush()
      row.append(label)
      if (item.detail) {
        const d = document.createElement('span')
        d.className = 'palette-detail'
        d.textContent = item.detail
        row.append(d)
      }
      if (item.hint) {
        const h = document.createElement('kbd')
        h.textContent = item.hint
        row.append(h)
      }
      row.addEventListener('mousemove', () => {
        if (this.selected !== i) {
          this.selected = i
          this.highlight()
        }
      })
      row.addEventListener('mousedown', (e) => e.preventDefault())
      row.addEventListener('click', () => this.pick(i))
      return row
    })
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'palette-empty'
      empty.textContent = this.input.value.startsWith('>') ? 'No matching commands' : 'No matching files'
      rows.push(empty)
    }
    this.list.replaceChildren(...rows)
    this.highlight()
  }

  private highlight(): void {
    this.list.querySelectorAll('.palette-item').forEach((row, i) => {
      row.setAttribute('aria-selected', String(i === this.selected))
    })
    this.input.setAttribute('aria-activedescendant', `palette-item-${this.selected}`)
    this.list.querySelector(`#palette-item-${this.selected}`)?.scrollIntoView({ block: 'nearest' })
  }

  private pick(index: number): void {
    const item = this.items[index]
    if (!item) return
    this.overlay.hidden = true
    this.returnFocus?.focus()
    item.run()
  }

  private onKey(e: KeyboardEvent): void {
    if (this.keyCapture) {
      e.preventDefault()
      e.stopPropagation()
      const key = keyString(e)
      if (!key) return // only a modifier so far
      if (key === 'Escape') return this.close()
      const done = this.keyCapture
      this.stopCapture()
      done(key)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (this.items.length === 0) return
      const d = e.key === 'ArrowDown' ? 1 : -1
      this.selected = (this.selected + d + this.items.length) % this.items.length
      this.highlight()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.pick(this.selected)
    }
  }
}
