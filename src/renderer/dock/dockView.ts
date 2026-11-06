/**
 * Draws a dock tree (src/renderer/dock/model.ts): splits with draggable
 * dividers, and tab stacks of panels. Panel elements are registered once and
 * then only moved around (never re-created), so editors and terminals keep
 * their state; a panel that isn't shown has `hidden = true`, which existing
 * code relies on. Panels not placed at all wait in a hidden store.
 */
import { activate, findStack, resize, setCollapsed, zoneAt, type DockNode, type SplitNode, type StackNode, type Zone } from './model'

export interface PanelDef {
  id: string
  title: string
  body: HTMLElement
  /** Buttons shown in the stack's tab strip while this panel is the active one. */
  actions?: HTMLElement
  /** Called whenever the panel becomes visible (e.g. to refit a terminal). */
  onShow?: () => void
  /** Can be closed in Edit Layout mode (default true; the editor can't). */
  closable?: boolean
}

export interface DockHooks {
  /** The arrangement changed through the dock itself (tab click, divider drag). */
  changed(root: DockNode): void
  closePanel(id: string): void
  drop(panel: string, targetStackId: string, zone: Zone): void
}

const el = (cls: string): HTMLDivElement => {
  const d = document.createElement('div')
  d.className = cls
  return d
}

export class DockView {
  private readonly panels = new Map<string, PanelDef & { tab?: HTMLElement }>()
  private readonly rootEl: HTMLDivElement
  private readonly store: HTMLDivElement
  private current: DockNode | null = null
  private visible = new Set<string>()
  /** Last scroll position of everything scrolled inside the dock. */
  private readonly scrolls = new Map<Element, { top: number; left: number }>()
  private _editing = false

  constructor(private readonly container: HTMLElement, private readonly hooks: DockHooks) {
    this.rootEl = el('dock-root')
    this.store = el('dock-store')
    this.store.hidden = true
    container.classList.add('dock')
    container.append(this.rootEl, this.store)
    container.addEventListener('scroll', (e) => {
      const t = e.target
      if (t instanceof Element) this.scrolls.set(t, { top: t.scrollTop, left: t.scrollLeft })
    }, true)
  }

  register(def: PanelDef): void {
    this.panels.set(def.id, { ...def })
    def.body.hidden = true
    def.body.classList.add('dock-panel-body')
    this.store.append(def.body)
    if (def.actions) {
      def.actions.hidden = true
      this.store.append(def.actions)
    }
  }

  get root(): DockNode | null {
    return this.current
  }

  get editing(): boolean {
    return this._editing
  }

  set editing(on: boolean) {
    this._editing = on
    this.container.classList.toggle('editing-layout', on)
    if (this.current) this.render(this.current)
  }

  titleOf(id: string): string {
    return this.panels.get(id)?.title ?? id
  }

  setTitle(id: string, title: string): void {
    const p = this.panels.get(id)
    if (!p) return
    p.title = title
    const label = p.tab?.querySelector('.dock-tab-label')
    if (label) label.textContent = title
  }

  /** Placed, active in its stack, and the stack isn't collapsed. */
  isShown(id: string): boolean {
    return this.visible.has(id)
  }

  /** Draw an arrangement, moving panel elements into place. */
  render(root: DockNode): void {
    this.current = root
    const before = this.visible
    this.visible = new Set()
    // Everything goes back to the store first; what's placed is moved out again below.
    for (const p of this.panels.values()) {
      p.body.hidden = true
      p.tab = undefined
      this.store.append(p.body)
      if (p.actions) {
        p.actions.hidden = true
        this.store.append(p.actions)
      }
    }
    this.rootEl.replaceChildren(this.node(root))
    // Moving an element out of the page loses its scroll position: put it back.
    for (const [elem, pos] of this.scrolls) {
      if (!elem.isConnected) continue
      if (elem.scrollTop !== pos.top) elem.scrollTop = pos.top
      if (elem.scrollLeft !== pos.left) elem.scrollLeft = pos.left
    }
    for (const elem of [...this.scrolls.keys()]) if (!elem.isConnected) this.scrolls.delete(elem)
    for (const id of this.visible) if (!before.has(id)) this.panels.get(id)?.onShow?.()
  }

  private node(n: DockNode): HTMLElement {
    return n.kind === 'stack' ? this.stack(n) : this.split(n)
  }

  private split(n: SplitNode): HTMLElement {
    const box = el(`dock-split dock-${n.dir}`)
    box.dataset.split = n.id
    n.children.forEach((c, i) => {
      if (i > 0) box.append(this.divider(n, i - 1, box))
      const cell = el('dock-cell')
      // A collapsed stack (the drawer after Ctrl+J) is only its tab strip: the rest of the split gets the space.
      cell.style.flex = c.kind === 'stack' && c.collapsed ? '0 0 auto' : `${n.sizes[i]} 1 0`
      cell.append(this.node(c))
      box.append(cell)
    })
    return box
  }

  private stack(n: StackNode): HTMLElement {
    const box = el(`dock-stack${n.collapsed ? ' collapsed' : ''}`)
    box.dataset.stack = n.id
    const strip = el('dock-tabs')
    const tabs = el('dock-tab-list')
    const actions = el('dock-actions')
    const body = el('dock-body')
    for (const id of n.panels) {
      const p = this.panels.get(id)
      if (!p) continue
      const tab = document.createElement('button')
      tab.className = `dock-tab${id === n.active ? ' active' : ''}`
      tab.dataset.panel = id
      const label = document.createElement('span')
      label.className = 'dock-tab-label'
      label.textContent = p.title
      tab.append(label)
      if (this._editing && p.closable !== false) {
        const close = document.createElement('span')
        close.className = 'dock-tab-close'
        close.textContent = '✕'
        close.title = `Close ${p.title}`
        close.addEventListener('click', (e) => {
          e.stopPropagation()
          this.hooks.closePanel(id)
        })
        tab.append(close)
      }
      tab.addEventListener('click', () => this.onTabClick(n, id))
      tab.addEventListener('pointerdown', (e) => this.startDrag(e, id))
      p.tab = tab
      tabs.append(tab)
      body.append(p.body)
      const on = id === n.active && !n.collapsed
      p.body.hidden = !on
      if (p.actions) {
        actions.append(p.actions)
        p.actions.hidden = id !== n.active
      }
      if (on) this.visible.add(id)
    }
    strip.append(tabs, actions)
    body.hidden = !!n.collapsed
    box.append(strip, body)
    return box
  }

  private onTabClick(stack: StackNode, id: string): void {
    if (!this.current) return
    let root = activate(this.current, id)
    // Clicking a tab of a collapsed stack (the drawer) opens it again.
    if (stack.collapsed) root = setCollapsed(root, stack.id, false)
    if (root === this.current) return
    this.render(root)
    this.hooks.changed(root)
  }

  private divider(n: SplitNode, index: number, box: HTMLElement): HTMLElement {
    const d = el('dock-divider')
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const horizontal = n.dir === 'row'
      const start = horizontal ? e.clientX : e.clientY
      const rect = box.getBoundingClientRect()
      const length = (horizontal ? rect.width : rect.height) || 1
      const startSizes = [...((this.current && findSplit(this.current, n.id)?.sizes) ?? n.sizes)]
      const cells = [...box.children].filter((c) => c.classList.contains('dock-cell')) as HTMLElement[]
      let latest: DockNode | null = this.current
      const move = (ev: PointerEvent) => {
        if (!this.current) return
        const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / length
        const sizes = [...startSizes]
        sizes[index] += delta
        sizes[index + 1] -= delta
        latest = resize(this.current, n.id, sizes)
        const fixed = findSplit(latest, n.id)?.sizes ?? sizes
        cells.forEach((c, i) => (c.style.flex = `${fixed[i]} 1 0`))
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (latest && latest !== this.current) {
          this.current = latest
          this.hooks.changed(latest)
          // Panels that care about their size (terminals) refit.
          for (const id of this.visible) this.panels.get(id)?.onShow?.()
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
    return d
  }

  // ---------- Edit Layout mode: drag a tab onto a stack ----------

  private startDrag(e: PointerEvent, panel: string): void {
    if (!this._editing || e.button > 0) return
    let target: { stack: HTMLElement; zone: Zone } | null = null
    const marker = el('dock-drop')
    const move = (ev: PointerEvent) => {
      const stack = (ev.target as Element | null)?.closest?.('.dock-stack') as HTMLElement | null
      if (!stack || !this.rootEl.contains(stack)) {
        target = null
        marker.remove()
        return
      }
      const zone = zoneAt(stack.getBoundingClientRect(), ev.clientX, ev.clientY)
      target = { stack, zone }
      marker.className = `dock-drop zone-${zone}`
      if (marker.parentElement !== stack) stack.append(marker)
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.container.classList.remove('dragging-panel')
      marker.remove()
      if (target?.stack.dataset.stack) this.hooks.drop(panel, target.stack.dataset.stack, target.zone)
    }
    this.container.classList.add('dragging-panel')
    document.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** The stack element a panel is in (for drop targets). */
  stackElement(stackId: string): HTMLElement | null {
    return this.rootEl.querySelector(`[data-stack="${CSS.escape(stackId)}"]`)
  }

  /** The stack holding a panel, in the current arrangement. */
  stackOf(panel: string): StackNode | null {
    return this.current ? findStack(this.current, panel) : null
  }
}

function findSplit(root: DockNode, id: string): SplitNode | null {
  if (root.kind === 'stack') return null
  if (root.id === id) return root
  for (const c of root.children) {
    const f = findSplit(c, id)
    if (f) return f
  }
  return null
}
