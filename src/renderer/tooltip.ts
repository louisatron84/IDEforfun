/**
 * A small floating box near the mouse, used for error messages and (soon)
 * type information. Content is built from text nodes only.
 */

export interface TooltipSection {
  /** Optional CSS class, e.g. 'error' or 'code'. */
  kind?: string
  text: string
}

export class Tooltip {
  private readonly el: HTMLDivElement

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'tooltip'
    this.el.hidden = true
    this.el.setAttribute('role', 'tooltip')
    document.body.append(this.el)
  }

  get isVisible(): boolean {
    return !this.el.hidden
  }

  /** Show below (or above, if there's no room) the given screen rectangle. */
  show(sections: TooltipSection[], anchor: { left: number; top: number; bottom: number }): void {
    this.el.replaceChildren(
      ...sections.map((s) => {
        const div = document.createElement('div')
        div.className = 'tooltip-section' + (s.kind ? ` ${s.kind}` : '')
        div.textContent = s.text
        return div
      })
    )
    this.el.hidden = false
    const box = this.el.getBoundingClientRect()
    const margin = 6
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin))
    const below = anchor.bottom + 4
    const top = below + box.height > window.innerHeight - margin ? anchor.top - box.height - 4 : below
    this.el.style.left = `${left}px`
    this.el.style.top = `${Math.max(margin, top)}px`
  }

  hide(): void {
    this.el.hidden = true
  }
}
