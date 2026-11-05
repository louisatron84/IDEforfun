import type { DirEntry } from '../shared/api'

const INDENT_PX = 12

/**
 * Sidebar file tree. Folder contents are fetched lazily the first time a
 * folder is expanded, so opening a huge project stays fast.
 */
export class FileTree {
  private selected: HTMLElement | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly onOpenFile: (entry: DirEntry) => void
  ) {}

  async setRoot(rootPath: string): Promise<void> {
    this.selected = null
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
      row.addEventListener('click', () => {
        this.select(row)
        this.onOpenFile(entry)
      })
    }
    return wrapper
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
