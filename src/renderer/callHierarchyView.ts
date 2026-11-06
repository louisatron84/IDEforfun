/**
 * The Calls tab in the bottom panel (Shift+Alt+H): who calls a function
 * (incoming) or what it calls (outgoing), as a tree you expand step by step.
 * Click a name to go to it; click "N calls" to go to the first call site.
 */
import type { Position } from './editor/textBuffer'
import type { CallItem } from './lsp/navigation'
import { SYMBOL_KIND } from './lsp/navigation'

export type Direction = 'incoming' | 'outgoing'

export interface CallHooks {
  calls(item: CallItem, direction: Direction): Promise<{ item: CallItem; at: Position[] }[]>
  open(path: string, pos: Position): void
  relative(path: string): string
}

/** Calls nested deeper than this are not expanded (recursion can go on forever). */
const MAX_DEPTH = 12

export class CallHierarchyView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly tree: HTMLDivElement
  private readonly title: HTMLDivElement
  private root: CallItem | null = null
  private direction: Direction = 'incoming'
  private readonly toggle: HTMLButtonElement
  private generation = 0

  constructor(private readonly hooks: CallHooks) {
    this.body = document.createElement('div')
    this.body.className = 'problems-view calls-view'
    this.title = document.createElement('div')
    this.title.className = 'references-summary'
    this.tree = document.createElement('div')
    this.tree.setAttribute('role', 'tree')
    this.body.append(this.title, this.tree)
    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    this.toggle = document.createElement('button')
    this.toggle.addEventListener('click', () => {
      this.direction = this.direction === 'incoming' ? 'outgoing' : 'incoming'
      void this.render()
    })
    this.actions.append(this.toggle)
    this.message('Put the cursor on a function and press Shift+Alt+H to see who calls it.')
  }

  message(text: string): void {
    this.generation++
    this.root = null
    this.title.textContent = ''
    const el = document.createElement('div')
    el.className = 'problems-empty'
    el.textContent = text
    this.tree.replaceChildren(el)
    this.updateToggle()
  }

  show(item: CallItem, direction: Direction = 'incoming'): void {
    this.root = item
    this.direction = direction
    void this.render()
  }

  private updateToggle(): void {
    this.toggle.textContent = this.direction === 'incoming' ? '⇄ Show what it calls' : '⇄ Show who calls it'
    this.toggle.title = 'Switch between callers (incoming) and callees (outgoing)'
    this.toggle.hidden = !this.root
  }

  private async render(): Promise<void> {
    const root = this.root
    if (!root) return
    this.updateToggle()
    this.title.textContent = this.direction === 'incoming' ? `Who calls ${root.name}` : `What ${root.name} calls`
    const node = this.node(root, [], 0, true)
    this.tree.replaceChildren(node)
  }

  /** One tree row, with its children loaded when expanded. */
  private node(item: CallItem, at: Position[], depth: number, expand: boolean, seen = new Set<string>()): HTMLElement {
    const wrap = document.createElement('div')
    wrap.setAttribute('role', 'treeitem')
    const row = document.createElement('div')
    row.className = 'calls-row'
    row.style.paddingLeft = `${8 + depth * 16}px`
    const twisty = document.createElement('span')
    twisty.className = 'calls-twisty'
    const key = `${item.path}:${item.nameStart.line}:${item.nameStart.col}`
    const recursive = seen.has(key)
    twisty.textContent = recursive || depth >= MAX_DEPTH ? ' ' : '▸'
    const icon = document.createElement('span')
    icon.className = `outline-icon kind-${SYMBOL_KIND[item.kind]?.name ?? 'function'}`
    icon.textContent = SYMBOL_KIND[item.kind]?.icon ?? 'ƒ'
    const name = document.createElement('span')
    name.className = 'calls-name'
    name.textContent = item.name + (recursive ? ' (recursive)' : '')
    const where = document.createElement('span')
    where.className = 'problem-where'
    where.textContent = `${item.detail ? item.detail + '  ' : ''}${this.hooks.relative(item.path)}:${item.nameStart.line + 1}`
    row.append(twisty, icon, name, where)
    if (at.length) {
      const count = document.createElement('button')
      count.className = 'calls-sites'
      count.textContent = `${at.length} call${at.length === 1 ? '' : 's'}`
      count.title = 'Go to the call'
      // Incoming: the calls are in this item's file. Outgoing: in the parent's.
      count.addEventListener('click', (e) => {
        e.stopPropagation()
        this.hooks.open(this.direction === 'incoming' ? item.path : this.parentPath(wrap) ?? item.path, at[0])
      })
      row.append(count)
    }
    wrap.dataset.path = item.path
    const children = document.createElement('div')
    children.hidden = true
    wrap.append(row, children)
    let loaded = false
    const open = async () => {
      if (recursive || depth >= MAX_DEPTH) return
      children.hidden = !children.hidden
      twisty.textContent = children.hidden ? '▸' : '▾'
      if (loaded || children.hidden) return
      loaded = true
      const gen = this.generation
      const loading = document.createElement('div')
      loading.className = 'problems-empty'
      loading.style.paddingLeft = `${24 + (depth + 1) * 16}px`
      loading.textContent = 'Loading…'
      children.replaceChildren(loading)
      let calls: { item: CallItem; at: Position[] }[] = []
      try {
        calls = await this.hooks.calls(item, this.direction)
      } catch { /* shown as "none" */ }
      if (gen !== this.generation) return
      if (!calls.length) {
        loading.textContent = this.direction === 'incoming' ? 'No callers found.' : 'No calls found.'
        return
      }
      const next = new Set(seen).add(key)
      children.replaceChildren(...calls.map((c) => this.node(c.item, c.at, depth + 1, false, next)))
    }
    twisty.addEventListener('click', (e) => {
      e.stopPropagation()
      void open()
    })
    row.addEventListener('click', () => this.hooks.open(item.path, item.nameStart))
    row.addEventListener('dblclick', () => void open())
    if (expand) void open()
    return wrap
  }

  private parentPath(wrap: HTMLElement): string | undefined {
    return wrap.parentElement?.closest<HTMLElement>('[data-path]')?.dataset.path
  }
}
