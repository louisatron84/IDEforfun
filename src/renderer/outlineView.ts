/**
 * The Outline tab in the sidebar: the classes, functions and methods of the
 * open Python file, nested, from the language server. The one the cursor is
 * in is highlighted; click one to go to it. Type to filter.
 */
import type { Position } from './editor/textBuffer'
import { SYMBOL_KIND, symbolPathAt, type DocSymbol } from './lsp/navigation'

export class OutlineView {
  readonly root: HTMLDivElement
  private readonly filter: HTMLInputElement
  private readonly list: HTMLDivElement
  private symbols: DocSymbol[] = []
  private note = 'Open a Python file to see its outline.'
  private rows = new Map<DocSymbol, HTMLElement>()
  private current: DocSymbol | null = null

  constructor(private readonly go: (s: DocSymbol) => void) {
    this.root = document.createElement('div')
    this.root.className = 'outline-view'
    this.filter = document.createElement('input')
    this.filter.className = 'search-input outline-filter'
    this.filter.placeholder = 'Filter'
    this.filter.setAttribute('aria-label', 'Filter the outline')
    this.filter.spellcheck = false
    this.filter.addEventListener('input', () => this.render())
    this.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.filter.value) {
        e.stopPropagation()
        this.filter.value = ''
        this.render()
      } else if (e.key === 'Enter') {
        const first = this.list.querySelector<HTMLButtonElement>('.outline-item')
        first?.click()
      }
    })
    this.list = document.createElement('div')
    this.list.className = 'outline-list'
    this.list.setAttribute('role', 'tree')
    this.root.append(this.filter, this.list)
    this.render()
  }

  /** New symbols for the shown file (or a note when there are none to show). */
  set(symbols: DocSymbol[], note = ''): void {
    this.symbols = symbols
    this.note = note
    this.render()
  }

  get all(): DocSymbol[] {
    return this.symbols
  }

  focusFilter(): void {
    this.filter.focus()
    this.filter.select()
  }

  /** Highlight the symbol the cursor is in. */
  highlight(p: Position | null): void {
    const path = p ? symbolPathAt(this.symbols, p) : []
    const inner = path[path.length - 1] ?? null
    if (inner === this.current) return
    this.rows.get(this.current!)?.classList.remove('current')
    this.current = inner
    const row = inner ? this.rows.get(inner) : undefined
    if (row) {
      row.classList.add('current')
      row.scrollIntoView({ block: 'nearest' })
    }
  }

  private render(): void {
    this.rows.clear()
    const q = this.filter.value.trim().toLowerCase()
    const items: HTMLElement[] = []
    const add = (s: DocSymbol, depth: number): boolean => {
      const childRows: HTMLElement[] = []
      const before = items.length
      for (const c of s.children) add(c, depth + 1)
      childRows.push(...items.splice(before))
      const match = !q || s.name.toLowerCase().includes(q)
      if (!match && !childRows.length) return false
      const b = document.createElement('button')
      b.className = 'outline-item'
      b.setAttribute('role', 'treeitem')
      b.style.paddingLeft = `${8 + depth * 14}px`
      const kind = SYMBOL_KIND[s.kind] ?? { icon: '·', name: 'symbol' }
      const icon = document.createElement('span')
      icon.className = `outline-icon kind-${kind.name}`
      icon.textContent = kind.icon
      icon.title = kind.name
      const name = document.createElement('span')
      name.className = 'outline-name'
      name.textContent = s.name
      b.append(icon, name)
      if (s.detail) {
        const d = document.createElement('span')
        d.className = 'outline-detail'
        d.textContent = s.detail
        b.append(d)
      }
      b.title = `${kind.name} ${s.name} (line ${s.nameStart.line + 1})`
      b.addEventListener('click', () => this.go(s))
      this.rows.set(s, b)
      items.push(b, ...childRows)
      return true
    }
    for (const s of this.symbols) add(s, 0)
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'problems-empty'
      empty.textContent = q && this.symbols.length ? `Nothing matches "${this.filter.value}".` : this.note || 'No classes or functions in this file.'
      this.list.replaceChildren(empty)
    } else this.list.replaceChildren(...items)
    const cur = this.current
    this.current = null
    if (cur) {
      // Re-apply the highlight (rows were rebuilt).
      const still = this.rows.get(cur)
      if (still) {
        still.classList.add('current')
        this.current = cur
      }
    }
  }
}
