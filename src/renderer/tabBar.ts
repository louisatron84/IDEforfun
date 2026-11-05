/**
 * The row of tabs above the editor. Redrawn from the Workspace whenever it changes.
 * A tab shows ● when it has unsaved changes; the × appears on hover.
 */
import type { Workspace } from './workspace'

export class TabBar {
  constructor(private readonly container: HTMLElement, private readonly workspace: Workspace) {
    // Mouse wheel scrolls the tab row sideways when there are many tabs.
    container.addEventListener('wheel', (e) => {
      if (e.deltaY) container.scrollLeft += e.deltaY
    }, { passive: true })
  }

  render(): void {
    const tabs = this.workspace.docs.map((doc) => {
      const tab = document.createElement('div')
      tab.className = 'tab'
      if (doc === this.workspace.active) tab.classList.add('active')
      if (doc.dirty) tab.classList.add('dirty')
      tab.title = doc.path
      tab.setAttribute('role', 'tab')

      const name = document.createElement('span')
      name.className = 'tab-name'
      name.textContent = doc.name

      const close = document.createElement('button')
      close.className = 'tab-close'
      close.title = 'Close (Ctrl+W)'
      close.setAttribute('aria-label', `Close ${doc.name}`)
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        this.workspace.close(doc)
      })

      tab.append(name, close)
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault() // middle-click closes
          this.workspace.close(doc)
        }
      })
      tab.addEventListener('click', () => this.workspace.activate(doc))
      return tab
    })
    this.container.replaceChildren(...tabs)
    this.container.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}
