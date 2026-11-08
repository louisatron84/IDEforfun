/**
 * The Welcome page: what you see when no file is open (and Help → Welcome).
 * Start actions (new file / folder, open), recent folders, things to do with
 * the open project, and the most useful shortcuts (as you've set them).
 * Every action is a command, so it does exactly what the menu item does.
 */
import type { CommandRegistry } from './keymap'
import { noteBlocks, type Span } from '../shared/releaseNotes'

export interface WelcomeHooks {
  commands: CommandRegistry
  /** The open folder, or null. */
  folder(): string | null
  recent(): Promise<string[]>
  openRecent(folder: string): void
  removeRecent(folder: string): Promise<void>
  /** Whether the page shows by itself when no file is open. */
  showWhenEmpty(): boolean
  setShowWhenEmpty(on: boolean): void
  /** Files are open behind the page: offer a way back to them. */
  canClose(): boolean
  close(): void
}

interface Action {
  label: string
  command: string
  detail?: string
}

const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export class WelcomePage {
  readonly el: HTMLDivElement
  private recentList: string[] = []
  /** After an update (or Help → Release Notes): shown at the top until dismissed. */
  private news: { version: string; notes: string } | null = null

  constructor(private readonly hooks: WelcomeHooks) {
    this.el = document.createElement('div')
    this.el.className = 'welcome'
    this.el.hidden = true
    this.el.setAttribute('role', 'region')
    this.el.setAttribute('aria-label', 'Welcome')
  }

  get isVisible(): boolean {
    return !this.el.hidden
  }

  show(): void {
    const wasHidden = this.el.hidden
    this.el.hidden = false
    this.render()
    void this.hooks.recent().then((list) => {
      this.recentList = list
      if (!this.el.hidden) this.render()
    }).catch(() => {})
    if (wasHidden) this.el.scrollTop = 0
  }

  hide(): void {
    this.el.hidden = true
  }

  setWhatsNew(news: { version: string; notes: string } | null): void {
    this.news = news
    if (!this.el.hidden) this.render()
  }

  /** Redraw if showing (e.g. a folder was opened, or shortcuts changed). */
  refresh(): void {
    if (!this.el.hidden) this.show()
  }

  private keyFor(command: string): string {
    return this.hooks.commands.keysOf(command)[0] ?? ''
  }

  private render(): void {
    const folder = this.hooks.folder()
    const page = document.createElement('div')
    page.className = 'welcome-page'

    const head = document.createElement('div')
    head.className = 'welcome-head'
    const title = document.createElement('h1')
    title.textContent = 'Forge'
    const sub = document.createElement('p')
    sub.textContent = folder ? `Working in ${folderName(folder)}` : 'A hand-written IDE for Python'
    head.append(title, sub)
    if (this.hooks.canClose()) {
      const back = document.createElement('button')
      back.className = 'welcome-close'
      back.textContent = '× Back to your files'
      back.title = 'Close the Welcome page (Escape)'
      back.addEventListener('click', () => this.hooks.close())
      head.append(back)
    }

    const left = document.createElement('div')
    left.className = 'welcome-col'
    const right = document.createElement('div')
    right.className = 'welcome-col'

    left.append(this.section('Start', [
      { label: 'New File…', command: 'file.new', detail: folder ? 'in the project (type a/b.py to make folders too)' : 'choose where to save it' },
      { label: 'New Folder…', command: 'file.newFolder', detail: folder ? 'in the project' : 'a new project folder, then open it' },
      { label: 'Open Folder…', command: 'file.openFolder' },
      { label: 'Open Folder by Path…', command: 'file.openFolderByPath', detail: 'type or paste a path' }
    ]))
    left.append(this.recentSection(folder))

    if (folder) {
      right.append(this.section('This project', [
        { label: 'Go to File…', command: 'palette.files' },
        { label: 'Project Graph', command: 'view.projectGraph', detail: 'how the modules fit together' },
        { label: 'Search in Project', command: 'search.project' },
        { label: 'Run Task…', command: 'tasks.run' },
        { label: 'Run Configurations…', command: 'run.selectConfig' },
        { label: 'Run All Tests', command: 'tests.runAll' },
        { label: 'Python Interpreter…', command: 'python.selectInterpreter' },
        { label: 'Python Packages…', command: 'python.packages' },
        { label: 'Project Settings', command: 'settings.project' }
      ]))
    }
    right.append(this.section('Useful shortcuts', [
      { label: 'Show All Commands', command: 'palette.commands' },
      { label: 'Go to File', command: 'palette.files' },
      { label: 'Run / Debug', command: 'run.smart' },
      { label: 'Toggle Terminal', command: 'terminal.toggle' },
      { label: 'Split Editor', command: 'view.split' },
      { label: 'Settings', command: 'settings.open' },
      { label: 'Keyboard Shortcuts…', command: 'keys.show' }
    ], true))

    const cols = document.createElement('div')
    cols.className = 'welcome-cols'
    cols.append(left, right)

    const foot = document.createElement('label')
    foot.className = 'welcome-foot'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.hooks.showWhenEmpty()
    box.addEventListener('change', () => this.hooks.setShowWhenEmpty(box.checked))
    foot.append(box, document.createTextNode(' Show this page when no files are open (Help → Welcome always shows it)'))

    page.append(head, ...(this.news ? [this.newsCard(this.news)] : []), cols, foot)
    this.el.replaceChildren(page)
  }

  /** "What's new in Forge X": the release notes, built as text (nothing in them can run as HTML). */
  private newsCard(news: { version: string; notes: string }): HTMLElement {
    const card = document.createElement('section')
    card.className = 'welcome-news'
    const top = document.createElement('div')
    top.className = 'welcome-news-head'
    const h = document.createElement('h2')
    h.textContent = `What's new in Forge ${news.version}`
    const close = document.createElement('button')
    close.className = 'welcome-news-close'
    close.textContent = '×'
    close.title = 'Dismiss (Help → Release Notes shows it again)'
    close.setAttribute('aria-label', 'Dismiss the release notes')
    close.addEventListener('click', () => this.setWhatsNew(null))
    top.append(h, close)
    card.append(top)
    const line = (parent: HTMLElement, spans: Span[]) => {
      for (const s of spans) {
        if (s.bold || s.code) {
          const e = document.createElement(s.code ? 'code' : 'strong')
          e.textContent = s.text
          parent.append(e)
        } else parent.append(document.createTextNode(s.text))
      }
      return parent
    }
    const blocks = noteBlocks(news.notes)
    if (!blocks.length) card.append(Object.assign(document.createElement('p'), { textContent: 'No notes for this version.' }))
    for (const b of blocks) {
      if (b.kind === 'ul') {
        const ul = document.createElement('ul')
        for (const item of b.items) ul.append(line(document.createElement('li'), item))
        card.append(ul)
      } else card.append(line(document.createElement(b.kind === 'h' ? 'h3' : 'p'), b.text))
    }
    return card
  }

  private section(title: string, actions: Action[], showKeys = false): HTMLElement {
    const sec = document.createElement('section')
    sec.className = 'welcome-section'
    const h = document.createElement('h2')
    h.textContent = title
    sec.append(h)
    for (const a of actions) {
      const cmd = this.hooks.commands.get(a.command)
      if (!cmd) continue
      const b = document.createElement('button')
      b.className = 'welcome-link'
      const label = document.createElement('span')
      label.className = 'welcome-label'
      label.textContent = a.label
      b.append(label)
      const key = this.keyFor(a.command)
      if (a.detail && !showKeys) {
        const d = document.createElement('span')
        d.className = 'welcome-detail wrap'
        d.textContent = a.detail
        b.append(d)
      }
      if (key) {
        const k = document.createElement('kbd')
        k.textContent = key
        b.append(k)
      }
      // Some commands only make sense at certain times (e.g. Run with a file open).
      const usable = !cmd.when || cmd.when()
      if (!usable && !showKeys) b.disabled = true
      if (showKeys) b.title = usable ? `Run "${cmd.title}"` : `${cmd.title} (not available right now)`
      b.addEventListener('click', () => {
        if (!cmd.when || cmd.when()) this.hooks.commands.run(a.command)
      })
      sec.append(b)
    }
    return sec
  }

  private recentSection(current: string | null): HTMLElement {
    const sec = document.createElement('section')
    sec.className = 'welcome-section'
    const h = document.createElement('h2')
    h.textContent = 'Recent'
    sec.append(h)
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const list = this.recentList.filter((f) => !current || norm(f) !== norm(current)).slice(0, 8)
    if (!list.length) {
      const none = document.createElement('p')
      none.className = 'welcome-detail'
      none.textContent = current ? 'Other folders you open will be listed here.' : 'Folders you open will be listed here.'
      sec.append(none)
      return sec
    }
    for (const folder of list) {
      const row = document.createElement('div')
      row.className = 'welcome-recent'
      const b = document.createElement('button')
      b.className = 'welcome-link'
      b.title = folder
      const name = document.createElement('span')
      name.className = 'welcome-label'
      name.textContent = folderName(folder)
      const path = document.createElement('span')
      path.className = 'welcome-detail'
      path.textContent = folder
      b.append(name, path)
      b.addEventListener('click', () => this.hooks.openRecent(folder))
      const x = document.createElement('button')
      x.className = 'welcome-remove'
      x.textContent = '×'
      x.title = 'Remove from the list'
      x.setAttribute('aria-label', `Remove ${folder} from recent folders`)
      x.addEventListener('click', () => void this.hooks.removeRecent(folder).then(() => this.show()))
      row.append(b, x)
      sec.append(row)
    }
    if (this.recentList.length > list.length + (current ? 1 : 0)) {
      const more = document.createElement('button')
      more.className = 'welcome-link'
      more.textContent = 'More…'
      more.addEventListener('click', () => this.hooks.commands.run('file.openRecent'))
      sec.append(more)
    }
    return sec
  }
}
