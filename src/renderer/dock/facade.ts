/**
 * The old bottom panel's API (show / hide / toggle / activeView / setTitle /
 * addView) on top of the dock, so existing call sites keep working: showing
 * a panel reveals it in the current task; hide and toggle act on the drawer
 * (the stack holding the terminal).
 */
import type { DockView } from './dockView'
import type { TaskController } from './tasks'

export interface PanelFacade {
  show(id: string): void
  hide(): void
  toggle(): void
  readonly activeView: string | null
  readonly isOpen: boolean
  setTitle(id: string, title: string): void
  addView(id: string, title: string, body: HTMLElement, actions: HTMLElement, onShow?: () => void): void
}

export function createPanelFacade(tasks: TaskController, dock: DockView): PanelFacade {
  return {
    show: (id) => tasks.reveal(id),
    hide: () => tasks.hide('terminal'),
    toggle: () => tasks.toggleDrawer(),
    get activeView() {
      const d = tasks.drawer
      return d && !d.collapsed ? d.active : null
    },
    get isOpen() {
      const d = tasks.drawer
      return !!d && !d.collapsed
    },
    setTitle: (id, title) => dock.setTitle(id, title),
    addView: (id, title, body, actions, onShow) => dock.register({ id, title, body, actions, onShow })
  }
}
