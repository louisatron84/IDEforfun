/**
 * Floating windows: a panel popped out of the dock into its own OS window
 * (drag it to another monitor). The panel's element is moved into the new
 * window's page, so it keeps its state and keeps working: the code driving
 * it still runs in the main window. Closing the window (or "Back to the
 * dock") puts the panel back in the layout.
 */
import type { DockView } from './dockView'

/** Panels that stay in the dock: the editor, and the terminal (it measures itself against its own window). */
export const CAN_FLOAT = (id: string): boolean => id !== 'editor' && id !== 'terminal'

export class FloatingPanels {
  private readonly windows = new Map<string, Window>()

  constructor(
    private readonly dock: DockView,
    private readonly hooks: {
      /** Take the panel out of the current layout (it's now floating). */
      removeFromLayout(id: string): void
      /** Put it back in the layout (its window closed). */
      placeBack(id: string): void
      note(message: string): void
    }
  ) {}

  float(id: string): void {
    if (!CAN_FLOAT(id)) return this.hooks.note('The editor and the terminal stay in the main window.')
    if (this.dock.isFloating(id)) return this.dock.focusFloating(id)
    const parts = this.dock.panelParts(id)
    if (!parts) return
    const w = window.open('about:blank', `forge-float-${id}`, 'width=640,height=460')
    if (!w) return this.hooks.note('Couldn\'t open a window for the panel.')
    const doc = w.document
    doc.title = `${parts.title} · Forge`
    const charset = doc.createElement('meta')
    charset.setAttribute('charset', 'utf-8')
    doc.head.append(charset)
    // The same styles as the main window (absolute addresses: the new page is about:blank).
    for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
      if (node instanceof HTMLLinkElement) {
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = node.href
        doc.head.append(link)
      } else doc.head.append(doc.importNode(node, true))
    }
    this.copyLook(doc)
    doc.body.className = 'floating-window'
    const bar = doc.createElement('div')
    bar.className = 'floating-bar'
    const title = doc.createElement('span')
    title.className = 'floating-title'
    title.textContent = parts.title
    const back = doc.createElement('button')
    back.className = 'floating-back'
    back.textContent = 'Back to the dock'
    back.title = 'Put this panel back in the main window'
    back.addEventListener('click', () => w.close())
    bar.append(title)
    const holder = doc.createElement('div')
    holder.className = 'floating-body'

    this.dock.setFloating(id, () => w.focus())
    this.windows.set(id, w)
    if (parts.actions) {
      bar.append(doc.adoptNode(parts.actions))
      parts.actions.hidden = false
    }
    bar.append(back)
    holder.append(doc.adoptNode(parts.body))
    parts.body.hidden = false
    doc.body.append(bar, holder)
    this.hooks.removeFromLayout(id)
    parts.onShow?.()
    // Closing the window (or Back to the dock): the panel comes home.
    w.addEventListener('pagehide', () => this.returned(id))
  }

  /** Put a floating panel back (e.g. before reloading). */
  dockBack(id: string): void {
    this.windows.get(id)?.close()
  }

  closeAll(): void {
    for (const id of [...this.windows.keys()]) this.dockBack(id)
  }

  /** Theme, density and sizes changed: apply them to the floating windows too. */
  syncLook(): void {
    for (const w of this.windows.values()) if (!w.closed) this.copyLook(w.document)
  }

  isFloating(id: string): boolean {
    return this.windows.has(id)
  }

  private returned(id: string): void {
    if (!this.windows.has(id)) return
    this.windows.delete(id)
    this.dock.setFloating(id, null)
    this.hooks.placeBack(id)
  }

  private copyLook(doc: Document): void {
    const from = document.documentElement
    const to = doc.documentElement
    for (const a of [...from.attributes]) if (a.name === 'style' || a.name.startsWith('data-')) to.setAttribute(a.name, a.value)
  }
}
