import type { DirEntry, GitState, GitStatusMap } from '../shared/api'
import { samePath } from './workspace'

const INDENT_PX = 12

/**
 * Sidebar file tree. Folder contents are fetched lazily the first time a
 * folder is expanded, so opening a huge project stays fast.
 */
export class FileTree {
  private selected: HTMLElement | null = null
  /** File rows currently in the tree, so the active tab's file can be highlighted. */
  private readonly fileRows = new Map<string, HTMLElement>()
  private readonly folderRows = new Map<string, HTMLElement>()
  /** Latest git status, keyed by normalized path (applied to rows as they're created). */
  private gitFiles = new Map<string, GitState>()
  private gitFolders = new Set<string>()

  constructor(
    private readonly container: HTMLElement,
    private readonly onOpenFile: (entry: DirEntry) => void
  ) {}

  async setRoot(rootPath: string): Promise<void> {
    this.selected = null
    this.fileRows.clear()
    this.folderRows.clear()
    this.gitFiles.clear()
    this.gitFolders.clear()
    const list = document.createElement('div')
    this.container.replaceChildren(list)
    await this.renderChildren(list, rootPath, 0)
  }

  private async renderChildren(list: HTMLElement, dir: string, depth: number): Promise<void> {
    let entries: DirEntry[]
    try {
      entries = await window.api.readDir(dir)
    } catch (err) {
      list.replaceChildren(this.messageRow(`Can't read folder: ${String(err)}`, depth))
      return
    }
    if (entries.length === 0) {
      list.replaceChildren(this.messageRow('(empty)', depth))
      return
    }
    list.replaceChildren(...entries.map((e) => this.renderEntry(e, depth)))
  }

  private renderEntry(entry: DirEntry, depth: number): HTMLElement {
    const wrapper = document.createElement('div')
    const row = document.createElement('div')
    row.className = entry.isDirectory ? 'tree-row dir' : 'tree-row file'
    row.style.paddingLeft = `${4 + depth * INDENT_PX}px`
    row.title = entry.path

    const chevron = document.createElement('span')
    chevron.className = 'tree-chevron'
    chevron.textContent = entry.isDirectory ? '▸' : ''
    const name = document.createElement('span')
    name.className = 'tree-name'
    name.textContent = entry.name
    row.append(chevron, name)
    wrapper.append(row)

    if (entry.isDirectory) {
      this.folderRows.set(entry.path, row)
      this.decorate(row, entry.path, true)
      const children = document.createElement('div')
      children.hidden = true
      wrapper.append(children)
      let loaded = false
      row.addEventListener('click', async () => {
        this.select(row)
        children.hidden = !children.hidden
        chevron.textContent = children.hidden ? '▸' : '▾'
        if (!children.hidden && !loaded) {
          loaded = true
          await this.renderChildren(children, entry.path, depth + 1)
        }
      })
    } else {
      this.fileRows.set(entry.path, row)
      this.decorate(row, entry.path, false)
      row.addEventListener('click', () => this.onOpenFile(entry))
    }
    return wrapper
  }

  /** Show git status: colored names and a letter badge for changed files, a dot on folders. */
  setGitStatus(status: GitStatusMap | null): void {
    this.gitFiles = new Map(Object.entries(status?.files ?? {}).map(([p, st]) => [normPath(p), st]))
    this.gitFolders = new Set((status?.folders ?? []).map(normPath))
    for (const [p, row] of this.fileRows) this.decorate(row, p, false)
    for (const [p, row] of this.folderRows) this.decorate(row, p, true)
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

  /** Highlight the row for this file (if its folder is expanded). */
  highlight(path: string | null): void {
    for (const [p, row] of this.fileRows) {
      if (path && samePath(p, path)) {
        if (row.isConnected) this.select(row)
        return
      }
    }
  }

  private select(row: HTMLElement): void {
    this.selected?.classList.remove('selected')
    row.classList.add('selected')
    this.selected = row
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
