/**
 * The bottom panel: a resizable area under the editor with tabs for views
 * such as Output and Terminal. Drag its top edge to resize.
 */

interface View {
  tab: HTMLButtonElement
  body: HTMLElement
  actions: HTMLElement
  onShow?: () => void
}

const HEIGHT_KEY = 'ideforfun.panelHeight'

export class Panel {
  readonly root: HTMLDivElement
  private readonly tabsEl: HTMLDivElement
  private readonly actionsEl: HTMLDivElement
  private readonly bodyEl: HTMLDivElement
  private readonly views = new Map<string, View>()
  private activeId: string | null = null

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'panel'
    this.root.hidden = true
    const resizer = document.createElement('div')
    resizer.className = 'panel-resizer'
    resizer.title = 'Drag to resize'
    const header = document.createElement('div')
    header.className = 'panel-header'
    this.tabsEl = document.createElement('div')
    this.tabsEl.className = 'panel-tabs'
    this.actionsEl = document.createElement('div')
    this.actionsEl.className = 'panel-actions'
    const close = document.createElement('button')
    close.className = 'panel-close'
    close.title = 'Close panel (Ctrl+J)'
    close.setAttribute('aria-label', 'Close panel')
    close.textContent = '×'
    close.addEventListener('click', () => this.hide())
    header.append(this.tabsEl, this.actionsEl, close)
    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'panel-body'
    this.root.append(resizer, header, this.bodyEl)
    container.append(this.root)

    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY))
      if (saved > 0) this.root.style.height = `${saved}px`
    } catch { /* storage unavailable: use the default height */ }
    this.setupResize(resizer, container)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  get activeView(): string | null {
    return this.isOpen ? this.activeId : null
  }

  addView(id: string, title: string, body: HTMLElement, actions: HTMLElement, onShow?: () => void): void {
    const tab = document.createElement('button')
    tab.className = 'panel-tab'
    tab.textContent = title
    tab.addEventListener('click', () => this.show(id))
    this.tabsEl.append(tab)
    body.hidden = true
    actions.hidden = true
    this.bodyEl.append(body)
    this.actionsEl.append(actions)
    this.views.set(id, { tab, body, actions, onShow })
  }

  show(id: string): void {
    this.root.hidden = false
    this.activeId = id
    for (const [viewId, v] of this.views) {
      const on = viewId === id
      v.tab.classList.toggle('active', on)
      v.body.hidden = !on
      v.actions.hidden = !on
    }
    this.views.get(id)?.onShow?.()
  }

  hide(): void {
    this.root.hidden = true
  }

  /** Ctrl+J: hide if open, otherwise show the last view. */
  toggle(): void {
    if (this.isOpen) this.hide()
    else this.show(this.activeId ?? this.views.keys().next().value!)
  }

  private setupResize(handle: HTMLElement, container: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = this.root.getBoundingClientRect().height
      const max = container.getBoundingClientRect().height * 0.85
      const onMove = (ev: MouseEvent) => {
        const h = Math.min(max, Math.max(80, startH + (startY - ev.clientY)))
        this.root.style.height = `${h}px`
        if (this.activeId) this.views.get(this.activeId)?.onShow?.()
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(this.root.getBoundingClientRect().height)))
        } catch { /* ignore */ }
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }
}
