// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { DockView } from './dockView'
import { TaskController } from './tasks'
import { defaultArrangement, findStack, PANEL_IDS, placedPanels, type DockNode } from './model'
import type { SavedLayouts } from '../../shared/layouts'

function setup(saved: SavedLayouts = {}) {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  document.body.append(container)
  let tasks!: TaskController
  const view = new DockView(container, { changed: (r) => tasks.changed(r), closePanel: (id) => tasks.closePanel(id), drop: (p, s, z) => tasks.drop(p, s, z) })
  for (const id of PANEL_IDS) view.register({ id, title: id, body: document.createElement('div'), closable: id !== 'editor' })
  const save = vi.fn()
  const taskChanged = vi.fn()
  tasks = new TaskController(view, { saved, save, taskChanged, schedule: (fn) => { fn(); return () => {} } })
  tasks.switchTo('code')
  return { tasks, view, save, taskChanged }
}

describe('TaskController', () => {
  it('switches arrangements and reports the task', () => {
    const { tasks, view, taskChanged } = setup()
    tasks.switchTo('connect')
    expect(tasks.current).toBe('connect')
    expect(view.isShown('graph')).toBe(true)
    expect(taskChanged).toHaveBeenLastCalledWith('connect')
  })

  it('reveal: a placed panel is activated (and its drawer opened)', () => {
    const { tasks } = setup()
    tasks.switchTo('debug')
    tasks.toggleDrawer()
    expect(tasks.isShown('terminal')).toBe(false)
    tasks.reveal('problems')
    expect(tasks.isShown('problems')).toBe(true)
  })

  it('reveal: a panel the task does not place appears in the drawer', () => {
    const { tasks, view, save } = setup()
    tasks.switchTo('connect')
    tasks.reveal('tests')
    expect(tasks.isShown('tests')).toBe(true)
    expect(view.stackOf('tests')!.panels).toContain('terminal')
    expect(save).toHaveBeenCalled()
  })

  it('reveal: side panels join the files stack', () => {
    const { tasks, view } = setup()
    tasks.switchTo('connect')
    tasks.reveal('git')
    expect(view.stackOf('git')!.panels).toContain('files')
  })

  it('reveal: the editor switches to Code, the graph to Connect, when not placed', () => {
    const { tasks } = setup()
    tasks.switchTo('connect')
    tasks.reveal('editor')
    expect(tasks.current).toBe('code')
    tasks.reveal('graph')
    expect(tasks.current).toBe('connect')
  })

  it('reveal in Debug with the editor placed only activates it', () => {
    const { tasks } = setup()
    tasks.switchTo('debug')
    tasks.reveal('editor')
    expect(tasks.current).toBe('debug')
    expect(tasks.isShown('editor')).toBe(true)
  })

  it('a drawer can be toggled; with no drawer, toggling reveals the terminal', () => {
    const run: DockNode = { kind: 'stack', id: 's1', panels: ['editor'], active: 'editor' }
    const { tasks } = setup({ run })
    tasks.switchTo('run')
    tasks.toggleDrawer()
    expect(tasks.isShown('terminal')).toBe(true)
    tasks.toggleDrawer()
    expect(tasks.isShown('terminal')).toBe(false)
  })

  it('uses saved arrangements and resets to the default', () => {
    const run: DockNode = { kind: 'stack', id: 's1', panels: ['editor', 'output'], active: 'output' }
    const { tasks, view, save } = setup({ run })
    tasks.switchTo('run')
    expect(placedPanels(view.root!)).toEqual(['editor', 'output'])
    tasks.resetCurrent()
    expect(view.root).toEqual(defaultArrangement('run'))
    expect(save).toHaveBeenCalled()
  })

  it('the editor cannot be closed; other panels can and come back', () => {
    const { tasks, view } = setup()
    tasks.closePanel('editor')
    expect(placedPanels(view.root!)).toContain('editor')
    tasks.closePanel('where')
    expect(tasks.hiddenPanels()).toContain('where')
    tasks.addPanel('where')
    expect(placedPanels(view.root!)).toContain('where')
    expect(findStack(view.root!, 'where')).not.toBeNull()
  })

  it('debugging switches to Debug and back, unless turned off or the user moved on', () => {
    const { tasks } = setup()
    tasks.switchTo('run')
    tasks.beginDebug(true)
    expect(tasks.current).toBe('debug')
    tasks.endDebug()
    expect(tasks.current).toBe('run')
    tasks.beginDebug(false)
    expect(tasks.current).toBe('run')
    tasks.beginDebug(true)
    tasks.switchTo('connect')
    tasks.endDebug()
    expect(tasks.current).toBe('connect')
  })
})
