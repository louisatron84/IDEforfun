import type { DirEntry, GitState, GitStatusMap } from '../shared/api'
import { nameProblem } from '../shared/names'
import { isInside, samePath } from './workspace'

const INDENT_PX = 12

export interface FileTreeHooks {
  openFile(path: string): void
  /** A file or folder was created (files are opened right away). */
  created(path: string, isDirectory: boolean): void
  renamed(oldPath: string, newPath: string): void
  /** Ask, move to the Recycle Bin, close tabs. Returns false if cancelled or it failed. */
  delete(path: string, isDirectory: boolean): Promise<boolean>
  error(message: string): void
}

interface Node {
  entry: DirEntry
  depth: number
  row: HTMLElement
  /** Folders only: the element holding the children, and whether they've been fetched. */
  children?: HTMLElement
  loaded?: boolean
}

/**
 * Sidebar file tree. Folder contents are fetched lazily the first time a
 * folder is expanded, so opening a huge project stays fast. Files and folders
 * can be created, renamed and deleted from here (buttons, right-click, F2, Delete).
 */
export class FileTree {
  private root: string | null = null
  private readonly header: HTMLElement
  private readonly list: HTMLElement
  private readonly menu: HTMLElement
  /** Rows currently in the tree, keyed by normalized path. */
  private readonly nodes = new Map<string, Node>()
  /** Folders the user has open (normalized), so refreshing keeps them open. */
  private readonly expanded = new Set<string>()
  private selectedPath: string | null = null
  /** Latest git status, keyed by normalized path (applied to rows as they're created). */
  private gitFiles = new Map<string, GitState>()
  private gitFolders = new Set<string>()
  /** The inline name box (new file / rename) currently open, if any. */
  private editing: { cancel(): void } | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly hooks: FileTreeHooks
  ) {
    this.header = document.createElement('div')
    this.header.className = 'tree-header'
    this.header.hidden = true
    this.header.append(
      this.headerButton('+ File', 'New File (Ctrl+N)', () => void this.startCreate(false)),
      this.headerButton('+ Folder', 'New Folder', () => void this.startCreate(true)),
      this.headerButton('⟳', 'Refresh', () => void this.refreshAll()),
      this.headerButton('⊟', 'Collapse All', () => this.collapseAll())
    )
    this.list = document.createElement('div')
    this.list.className = 'tree-list'
    this.container.tabIndex = 0
    this.container.replaceChildren(this.header, this.list)

    this.menu = document.createElement('div')
    this.menu.className = 'context-menu'
    this.menu.hidden = true
    this.menu.setAttribute('role', 'menu')
    document.body.append(this.menu)
    window.addEventListener('mousedown', (e) => {
      if (!this.menu.contains(e.target as globalThis.Node)) this.hideMenu()
    })
    window.addEventListener('blur', () => this.hideMenu())

    this.container.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!this.root) return
      const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.tree-row[data-path]')
      const node = rowEl ? this.nodes.get(normPath(rowEl.dataset.path!)) : undefined
      if (node) this.select(node.entry.path)
      this.showMenu(e.clientX, e.clientY, node?.entry ?? null)
    })
    this.container.addEventListener('keydown', (e) => this.onKeyDown(e))
  }

  get hasRoot(): boolean {
    return this.root !== null
  }

  async setRoot(rootPath: string): Promise<void> {
    this.editing?.cancel()
    this.root = rootPath
    this.selectedPath = null
    this.nodes.clear()
    this.expanded.clear()
    this.gitFiles.clear()
    this.gitFolders.clear()
    this.header.hidden = false
    await this.renderChildren(this.list, rootPath, 0)
  }

  // ---------- rendering ----------

  private async renderChildren(list: HTMLElement, dir: string, depth: number): Promise<void> {
    let entries: DirEntry[]
    try {
      entries = await window.api.readDir(dir)
    } catch (err) {
      list.replaceChildren(this.messageRow(`Can't read folder: ${String(err)}`, depth))
      return
    }
    // Forget rows that were in this list before (they're being replaced).
    for (const el of list.querySelectorAll<HTMLElement>('.tree-row[data-path]')) {
      const key = normPath(el.dataset.path!)
      if (this.nodes.get(key)?.row === el) this.nodes.delete(key)
    }
    if (entries.length === 0) {
      list.replaceChildren(this.messageRow('(empty)', depth))
      return
    }
    const wrappers = entries.map((e) => this.renderEntry(e, depth))
    list.replaceChildren(...wrappers)
    // Re-open folders that were open before a refresh.
    await Promise.all(
      entries
        .filter((e) => e.isDirectory && this.expanded.has(normPath(e.path)))
        .map((e) => this.setExpanded(this.nodes.get(normPath(e.path))!, true))
    )
  }

  private renderEntry(entry: DirEntry, depth: number): HTMLElement {
    const wrapper = document.createElement('div')
    const row = document.createElement('div')
    row.className = entry.isDirectory ? 'tree-row dir' : 'tree-row file'
    row.style.paddingLeft = `${4 + depth * INDENT_PX}px`
    row.title = entry.path
    row.dataset.path = entry.path

    const chevron = document.createElement('span')
    chevron.className = 'tree-chevron'
    chevron.textContent = entry.isDirectory ? '▸' : ''
    const name = document.createElement('span')
    name.className = 'tree-name'
    name.textContent = entry.name
    row.append(chevron, name)
    wrapper.append(row)

    const node: Node = { entry, depth, row }
    this.nodes.set(normPath(entry.path), node)
    if (normPath(entry.path) === this.selectedPath) row.classList.add('selected')
    this.decorate(row, entry.path, entry.isDirectory)

    if (entry.isDirectory) {
      node.children = document.createElement('div')
      node.children.hidden = true
      wrapper.append(node.children)
      row.addEventListener('click', () => {
        this.select(entry.path)
        void this.setExpanded(node, Boolean(node.children!.hidden))
      })
    } else {
      row.addEventListener('click', () => {
        this.select(entry.path)
        this.hooks.openFile(entry.path)
      })
    }
    return wrapper
  }

  private async setExpanded(node: Node, open: boolean): Promise<void> {
    if (!node.children) return
    node.children.hidden = !open
    node.row.querySelector('.tree-chevron')!.textContent = open ? '▾' : '▸'
    const key = normPath(node.entry.path)
    if (open) this.expanded.add(key)
    else this.expanded.delete(key)
    if (open && !node.loaded) {
      node.loaded = true
      await this.renderChildren(node.children, node.entry.path, node.depth + 1)
    }
  }

  /** Re-read one folder (or the root) from disk, keeping open folders open. */
  async refresh(dir: string): Promise<void> {
    if (!this.root) return
    if (samePath(dir, this.root)) return this.renderChildren(this.list, this.root, 0)
    const node = this.nodes.get(normPath(dir))
    if (!node?.children) return
    if (!node.loaded) return // not fetched yet: it will be read fresh when opened
    await this.renderChildren(node.children, dir, node.depth + 1)
  }

  async refreshAll(): Promise<void> {
    if (this.root) await this.renderChildren(this.list, this.root, 0)
    this.highlight(this.selectedPath)
  }

  collapseAll(): void {
    for (const node of this.nodes.values()) if (node.children && !node.children.hidden) void this.setExpanded(node, false)
    this.expanded.clear()
  }

  /** Open every folder above `path` so its row exists and is visible. */
  async reveal(path: string): Promise<Node | undefined> {
    if (!this.root || !isInside(path, this.root) || samePath(path, this.root)) return undefined
    const sep = this.root.includes('\\') ? '\\' : '/'
    const rel = path.slice(this.root.length).replace(/^[\\/]+/, '').split(/[\\/]/)
    let current = this.root.replace(/[\\/]+$/, '')
    for (const part of rel.slice(0, -1)) {
      current += sep + part
      const node = this.nodes.get(normPath(current))
      if (!node) return undefined
      if (node.children!.hidden || !node.loaded) await this.setExpanded(node, true)
    }
    const node = this.nodes.get(normPath(path))
    node?.row.scrollIntoView({ block: 'nearest' })
    return node
  }

  // ---------- git decorations ----------

  /** Show git status: colored names and a letter badge for changed files, a dot on folders. */
  setGitStatus(status: GitStatusMap | null): void {
    this.gitFiles = new Map(Object.entries(status?.files ?? {}).map(([p, st]) => [normPath(p), st]))
    this.gitFolders = new Set((status?.folders ?? []).map(normPath))
    for (const node of this.nodes.values()) this.decorate(node.row, node.entry.path, node.entry.isDirectory)
  }

  private decorate(row: HTMLElement, path: string, isFolder: boolean): void {
    const key = normPath(path)
    row.querySelector('.git-badge')?.remove()
    if (isFolder) {
      row.classList.toggle('git-dirty', this.gitFolders.has(key))
      return
    }
    const state = this.gitFiles.get(key)
    if (state) row.dataset.git = state
    else delete row.dataset.git
    if (!state) return
    const badge = document.createElement('span')
    badge.className = 'git-badge'
    badge.textContent = GIT_LETTER[state]
    badge.title = state
    row.append(badge)
  }

  // ---------- selection ----------

  /** Highlight the row for this file (if its folder is expanded). */
  highlight(path: string | null): void {
    if (!path) return
    const node = this.nodes.get(normPath(path))
    if (node?.row.isConnected) this.select(node.entry.path)
  }

  private select(path: string): void {
    const key = normPath(path)
    if (this.selectedPath) this.nodes.get(this.selectedPath)?.row.classList.remove('selected')
    this.selectedPath = key
    this.nodes.get(key)?.row.classList.add('selected')
  }

  private get selectedEntry(): DirEntry | null {
    return (this.selectedPath && this.nodes.get(this.selectedPath)?.entry) || null
  }

  /** Where "New File" goes: the selected folder, the selected file's folder, or the root. */
  private targetFolder(entry = this.selectedEntry): string | null {
    if (!this.root) return null
    if (!entry) return this.root
    return entry.isDirectory ? entry.path : parentOf(entry.path)
  }

  // ---------- create / rename / delete ----------

  /** Show a name box in `dir` (default: selected folder); creates the file/folder on Enter. */
  async startCreate(isDirectory: boolean, dir = this.targetFolder()): Promise<void> {
    if (!dir || !this.root) return
    this.hideMenu()
    this.editing?.cancel()
    let list = this.list
    let depth = 0
    if (!samePath(dir, this.root)) {
      const node = (await this.reveal(dir)) ?? this.nodes.get(normPath(dir))
      if (!node?.children) return
      await this.setExpanded(node, true)
      list = node.children
      depth = node.depth + 1
    }
    list.querySelector(':scope > .tree-row.muted')?.remove() // "(empty)"
    const row = document.createElement('div')
    row.className = `tree-row editing ${isDirectory ? 'dir' : 'file'}`
    row.style.paddingLeft = `${4 + depth * INDENT_PX}px`
    const chevron = document.createElement('span')
    chevron.className = 'tree-chevron'
    chevron.textContent = isDirectory ? '▸' : ''
    row.append(chevron)
    list.prepend(row)

    this.nameBox(row, '', {
      placeholder: isDirectory ? 'folder name' : 'file name (e.g. app.py or pkg/app.py)',
      check: (name) => nameProblem(name),
      commit: async (name) => {
        const path = await window.api.createEntry(dir, name, isDirectory)
        await this.refresh(dir)
        // "pkg/app.py" may have created folders: open the way down to the new item.
        await this.reveal(path)
        this.select(path)
        this.hooks.created(path, isDirectory)
      },
      cleanup: () => {
        row.remove()
        if (!list.children.length) list.append(this.messageRow('(empty)', depth))
      }
    })
  }

  /** Turn the row's name into a box for typing the new name. */
  async startRename(path = this.selectedEntry?.path): Promise<void> {
    if (!path) return
    this.hideMenu()
    this.editing?.cancel()
    const node = await this.reveal(path)
    if (!node) return
    this.select(path)
    const nameEl = node.row.querySelector<HTMLElement>('.tree-name')!
    const oldName = node.entry.name
    nameEl.hidden = true
    node.row.classList.add('editing')
    this.nameBox(node.row, oldName, {
      check: (name) => nameProblem(name, false),
      commit: async (name) => {
        if (name === oldName) return
        const newPath = await window.api.renameEntry(path, name)
        const key = normPath(path)
        // Keep renamed folders (and open folders inside them) open.
        for (const p of [...this.expanded]) {
          if (p === key || p.startsWith(key + normPath(sepOf(path)))) {
            this.expanded.delete(p)
            this.expanded.add(normPath(newPath) + p.slice(key.length))
          }
        }
        this.hooks.renamed(path, newPath)
        await this.refresh(parentOf(path))
        this.select(newPath)
      },
      cleanup: () => {
        nameEl.hidden = false
        node.row.classList.remove('editing')
      }
    })
  }

  async deleteEntry(entry = this.selectedEntry): Promise<void> {
    if (!entry) return
    this.hideMenu()
    if (!(await this.hooks.delete(entry.path, entry.isDirectory))) return
    if (this.selectedPath === normPath(entry.path)) this.selectedPath = null
    for (const p of [...this.expanded]) if (isInside(p, entry.path)) this.expanded.delete(p)
    await this.refresh(parentOf(entry.path))
    this.container.focus()
  }

  /**
   * An inline text box inside a tree row. Enter (or clicking away) commits,
   * Escape cancels. Problems with the name are shown under the box as you type.
   */
  private nameBox(row: HTMLElement, initial: string, o: {
    placeholder?: string
    check: (name: string) => string | null
    commit: (name: string) => Promise<void>
    cleanup: () => void
  }): void {
    const input = document.createElement('input')
    input.className = 'tree-input'
    input.value = initial
    input.spellcheck = false
    if (o.placeholder) input.placeholder = o.placeholder
    const problem = document.createElement('div')
    problem.className = 'tree-input-error'
    problem.hidden = true
    row.append(input, problem)

    let finished = false
    const finish = (refocus: boolean) => {
      if (finished) return
      finished = true
      this.editing = null
      input.remove()
      problem.remove()
      o.cleanup()
      if (refocus) this.container.focus()
    }
    const showProblem = (text: string | null) => {
      problem.textContent = text ?? ''
      problem.hidden = !text
      input.classList.toggle('invalid', !!text)
    }
    const submit = async (fromBlur: boolean) => {
      if (finished) return
      const name = input.value.trim()
      // Clicking away from an empty or unchanged box just cancels it.
      if (!name || (fromBlur && name === initial)) return finish(false)
      const bad = o.check(name)
      if (bad) {
        if (fromBlur) return finish(false)
        return showProblem(bad)
      }
      input.disabled = true
      try {
        await o.commit(name)
        finish(!fromBlur)
      } catch (err) {
        if (fromBlur) {
          finish(false)
          this.hooks.error(cleanError(err))
        } else {
          input.disabled = false
          showProblem(cleanError(err))
          input.focus()
        }
      }
    }
    input.addEventListener('input', () => showProblem(input.value.trim() ? o.check(input.value.trim()) : null))
    input.addEventListener('keydown', (e) => {
      e.stopPropagation() // keep F2/Delete etc. for the box, not the tree
      if (e.key === 'Enter') {
        e.preventDefault()
        void submit(false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(true)
      }
    })
    input.addEventListener('blur', () => {
      if (!input.disabled) void submit(true)
    })
    input.addEventListener('click', (e) => e.stopPropagation())
    this.editing = { cancel: () => finish(false) }
    input.focus()
    // Select the name without its extension, like other editors.
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }

  // ---------- keyboard and context menu ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target !== this.container) return
    if (e.key === 'F2') {
      e.preventDefault()
      void this.startRename()
    } else if (e.key === 'Delete') {
      e.preventDefault()
      void this.deleteEntry()
    } else if (e.key === 'Enter' && this.selectedEntry) {
      e.preventDefault()
      this.nodes.get(this.selectedPath!)?.row.click()
    }
  }

  private showMenu(x: number, y: number, entry: DirEntry | null): void {
    const dir = this.targetFolder(entry)
    const items: ([string, string, () => void] | null)[] = [
      ['New File…', 'Ctrl+N', () => void this.startCreate(false, dir)],
      ['New Folder…', '', () => void this.startCreate(true, dir)]
    ]
    if (entry) {
      items.push(
        null,
        ['Rename…', 'F2', () => void this.startRename(entry.path)],
        ['Delete', 'Delete', () => void this.deleteEntry(entry)],
        null,
        ['Copy Path', '', () => void navigator.clipboard.writeText(entry.path)],
        ['Copy Relative Path', '', () => void navigator.clipboard.writeText(this.relative(entry.path))]
      )
    }
    this.menu.replaceChildren(...items.map((item) => {
      if (!item) {
        const hr = document.createElement('div')
        hr.className = 'context-menu-sep'
        return hr
      }
      const [label, keys, run] = item
      const b = document.createElement('button')
      b.setAttribute('role', 'menuitem')
      const l = document.createElement('span')
      l.textContent = label
      const k = document.createElement('span')
      k.className = 'context-menu-keys'
      k.textContent = keys
      b.append(l, k)
      b.addEventListener('click', () => {
        this.hideMenu()
        run()
      })
      return b
    }))
    this.menu.hidden = false
    // Keep the menu on screen.
    const r = this.menu.getBoundingClientRect()
    this.menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`
    this.menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`
  }

  private hideMenu(): void {
    this.menu.hidden = true
  }

  private relative(path: string): string {
    if (!this.root) return path
    return path.slice(this.root.length).replace(/^[\\/]+/, '')
  }

  private headerButton(label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'tree-header-button'
    b.textContent = label
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', run)
    return b
  }

  private messageRow(text: string, depth: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tree-row muted'
    row.style.paddingLeft = `${4 + depth * INDENT_PX + 16}px`
    row.textContent = text
    return row
  }
}

const GIT_LETTER: Record<GitState, string> = {
  modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R', conflict: '!'
}

/** Windows paths compare case-insensitively. */
function normPath(p: string): string {
  return /^[a-zA-Z]:/.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p
}

function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : path
}

/** "Error invoking remote method 'fs:create': Error: x" → "x" */
function cleanError(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
