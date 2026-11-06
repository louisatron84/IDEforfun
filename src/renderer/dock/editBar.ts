/**
 * The floating bar shown in Edit Layout mode: Done, Reset this task, and
 * "Add panel…" listing the panels the current task doesn't place.
 */
export interface EditBarHooks {
  done(): void
  reset(): void
  add(panel: string): void
  /** Panels that can be added back. */
  hidden(): string[]
  title(panel: string): string
}

export class EditBar {
  readonly el: HTMLDivElement
  private readonly select: HTMLSelectElement

  constructor(container: HTMLElement, private readonly hooks: EditBarHooks) {
    this.el = document.createElement('div')
    this.el.className = 'edit-bar'
    this.el.hidden = true
    this.el.setAttribute('role', 'toolbar')
    this.el.setAttribute('aria-label', 'Edit layout')
    const label = document.createElement('span')
    label.className = 'edit-bar-label'
    label.textContent = 'Edit Layout: drag tabs onto a side or the middle of a panel'
    this.select = document.createElement('select')
    this.select.addEventListener('change', () => {
      const v = this.select.value
      if (v) hooks.add(v)
      this.fill()
    })
    const button = (text: string, fn: () => void, cls = '') => {
      const b = document.createElement('button')
      b.textContent = text
      if (cls) b.className = cls
      b.addEventListener('click', fn)
      return b
    }
    this.el.append(label, this.select, button('Reset this task', () => hooks.reset()), button('Done', () => hooks.done(), 'primary'))
    container.append(this.el)
  }

  show(): void {
    this.fill()
    this.el.hidden = false
  }

  hide(): void {
    this.el.hidden = true
  }

  /** Refresh the "Add panel…" list (after the layout changed). */
  fill(): void {
    const first = document.createElement('option')
    first.value = ''
    first.textContent = 'Add panel…'
    const options = this.hooks.hidden().map((id) => {
      const o = document.createElement('option')
      o.value = id
      o.textContent = this.hooks.title(id)
      return o
    })
    this.select.replaceChildren(first, ...options)
    this.select.value = ''
    this.select.disabled = options.length === 0
  }
}
