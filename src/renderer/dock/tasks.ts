/**
 * The tasks (Code, Connect, Debug, Run): one dock arrangement each. Switching
 * task swaps the whole arrangement; revealing a panel makes it visible in the
 * current task, placing it if this task doesn't have it yet; changes are
 * saved per user (debounced).
 */
import type { DockView } from './dockView'
import {
  EDITOR, PANEL_IDS, TASKS, defaultArrangement, findStack, insertAtEdge, insertPanel, movePanel, placedPanels, removePanel, setCollapsed, activate,
  type DockNode, type TaskId, type Zone
} from './model'
import type { SavedLayouts } from '../../shared/layouts'

/** Panels that live at the side (with Files); everything else goes in the drawer (with Terminal). */
const SIDE_PANELS = new Set(['files', 'search', 'outline', 'git', 'where', 'infile'])
const DRAWER_ANCHOR = 'terminal'
/** Panels that belong with the Graph: revealing one goes to Connect. */
const CONNECT_PANELS = new Set(['toolbox', 'box'])
const SIDE_ANCHOR = 'files'

type Schedule = (fn: () => void, ms: number) => () => void
const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export class TaskController {
  private readonly arrangements: Record<TaskId, DockNode>
  private task: TaskId = 'code'
  private beforeDebug: TaskId | null = null
  private cancelSave: (() => void) | null = null
  private readonly schedule: Schedule

  constructor(
    private readonly view: DockView,
    private readonly opts: { saved: SavedLayouts; save(layouts: SavedLayouts): void; taskChanged(task: TaskId): void; schedule?: Schedule }
  ) {
    this.schedule = opts.schedule ?? defaultSchedule
    this.arrangements = Object.fromEntries(TASKS.map((t) => [t, opts.saved[t] ?? defaultArrangement(t)])) as Record<TaskId, DockNode>
  }

  get current(): TaskId {
    return this.task
  }

  private get root(): DockNode {
    return this.arrangements[this.task]
  }

  switchTo(task: TaskId): void {
    const changed = task !== this.task
    this.task = task
    this.view.render(this.root)
    if (changed) this.view.animate?.('task')
    this.opts.taskChanged(task)
  }

  /** Saved arrangements (they load after startup): use them, and redraw the current task. */
  useSaved(saved: SavedLayouts): void {
    for (const t of TASKS) if (saved[t]) this.arrangements[t] = saved[t]!
    if (saved[this.task]) this.view.render(this.root)
  }

  /** The dock changed it (tab click, divider drag). */
  changed(root: DockNode): void {
    this.arrangements[this.task] = root
    this.saveSoon()
  }

  /** Make a panel visible in the current task (placing it if needed). */
  reveal(panel: string): void {
    // In its own window: bring that forward.
    if (this.view.isFloating?.(panel)) return this.view.focusFloating?.(panel)
    const root = this.root
    const stack = findStack(root, panel)
    if (stack) {
      let next = activate(root, panel)
      if (stack.collapsed) next = setCollapsed(next, stack.id, false)
      if (next !== root) this.update(next)
      return
    }
    if (panel === EDITOR) return this.switchTo('code')
    if (panel === 'graph') return this.switchTo('connect')
    if (CONNECT_PANELS.has(panel) && this.task !== 'connect') {
      this.switchTo('connect')
      return this.reveal(panel)
    }
    this.update(this.place(root, panel))
  }

  /** Where a panel goes when it isn't placed: with Files, in the drawer, or along an edge. */
  private place(root: DockNode, panel: string): DockNode {
    if (SIDE_PANELS.has(panel)) {
      const side = findStack(root, SIDE_ANCHOR)
      return side ? insertPanel(root, panel, side.id, 'center') : insertAtEdge(root, panel, 'left', 0.2)
    }
    if (panel === EDITOR || panel === 'graph' || panel === 'pipeline' || panel === 'database') return insertAtEdge(root, panel, 'right', 0.6)
    if (CONNECT_PANELS.has(panel)) return insertAtEdge(root, panel, 'right', 0.26)
    const drawer = findStack(root, DRAWER_ANCHOR)
    if (drawer) {
      const next = insertPanel(root, panel, drawer.id, 'center')
      const s = findStack(next, panel)!
      return s.collapsed ? setCollapsed(next, s.id, false) : next
    }
    return insertAtEdge(root, panel, 'bottom', 0.3)
  }

  /** Collapse the drawer a panel is in (other panels are left alone). */
  hide(panel: string): void {
    const s = findStack(this.root, panel)
    if (s && s.panels.includes(DRAWER_ANCHOR) && !s.collapsed) this.update(setCollapsed(this.root, s.id, true))
  }

  /** Ctrl+J: collapse or expand the drawer (the stack holding the terminal). */
  toggleDrawer(): void {
    const s = findStack(this.root, DRAWER_ANCHOR)
    if (!s) return this.reveal(DRAWER_ANCHOR)
    this.update(setCollapsed(this.root, s.id, !s.collapsed))
  }

  /** The drawer stack, if the current task has one. */
  get drawer(): { panels: string[]; active: string; collapsed: boolean } | null {
    const s = findStack(this.root, DRAWER_ANCHOR)
    return s ? { panels: s.panels, active: s.active, collapsed: !!s.collapsed } : null
  }

  isShown(panel: string): boolean {
    return this.view.isShown(panel)
  }

  resetCurrent(): void {
    this.update(defaultArrangement(this.task), true)
  }

  closePanel(id: string): void {
    if (id === EDITOR) return
    const next = removePanel(this.root, id)
    if (next) this.update(next, true)
  }

  /** Put a closed panel back (Edit Layout's "Add panel"), without switching task. */
  addPanel(id: string): void {
    if (findStack(this.root, id)) return this.reveal(id)
    this.update(this.place(this.root, id), true)
  }

  /** Panels the current task doesn't place. */
  hiddenPanels(): string[] {
    const placed = new Set(placedPanels(this.root))
    return PANEL_IDS.filter((p) => !placed.has(p))
  }

  /** Drag and drop in Edit Layout mode. */
  drop(panel: string, targetStackId: string, zone: Zone): void {
    const next = movePanel(this.root, panel, targetStackId, zone)
    if (next !== this.root) this.update(next, true)
  }

  beginDebug(enabled: boolean): void {
    if (!enabled || this.task === 'debug') return
    this.beforeDebug = this.task
    this.switchTo('debug')
  }

  endDebug(): void {
    const back = this.beforeDebug
    this.beforeDebug = null
    if (back && this.task === 'debug') this.switchTo(back)
  }

  private update(root: DockNode, animate = false): void {
    this.arrangements[this.task] = root
    this.view.render(root)
    if (animate) this.view.animate?.('layout')
    this.saveSoon()
  }

  private saveSoon(): void {
    this.cancelSave?.()
    this.cancelSave = this.schedule(() => {
      this.cancelSave = null
      this.opts.save({ ...this.arrangements })
    }, 500)
  }

  /** Save now (e.g. when leaving Edit Layout mode or closing the window). */
  flush(): void {
    if (!this.cancelSave) return
    this.cancelSave()
    this.cancelSave = null
    this.opts.save({ ...this.arrangements })
  }
}
