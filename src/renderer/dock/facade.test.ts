// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { DockView } from './dockView'
import { TaskController } from './tasks'
import { createPanelFacade } from './facade'
import { PANEL_IDS } from './model'

function setup() {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  document.body.append(container)
  let tasks!: TaskController
  const dock = new DockView(container, { changed: (r) => tasks.changed(r), closePanel: (id) => tasks.closePanel(id), drop: (p, s, z) => tasks.drop(p, s, z) })
  tasks = new TaskController(dock, { saved: {}, save: () => {}, taskChanged: () => {}, schedule: (fn) => { fn(); return () => {} } })
  const panel = createPanelFacade(tasks, dock)
  for (const id of PANEL_IDS) {
    if (['terminal', 'problems', 'output'].includes(id)) continue
    dock.register({ id, title: id, body: document.createElement('div') })
  }
  return { tasks, dock, panel }
}

describe('panel facade (the old bottom panel API on top of the dock)', () => {
  it('addView registers panels that show() reveals', () => {
    const { tasks, panel } = setup()
    for (const id of ['terminal', 'problems', 'output']) panel.addView(id, id, document.createElement('div'), document.createElement('div'))
    tasks.switchTo('code')
    panel.show('output')
    expect(tasks.isShown('output')).toBe(true)
    expect(panel.activeView).toBe('output')
    expect(panel.isOpen).toBe(true)
  })

  it('toggle() collapses the drawer and brings it back; activeView is null while collapsed', () => {
    const { tasks, panel } = setup()
    for (const id of ['terminal', 'problems', 'output']) panel.addView(id, id, document.createElement('div'), document.createElement('div'))
    tasks.switchTo('code')
    panel.show('problems')
    panel.toggle()
    expect(panel.activeView).toBeNull()
    expect(panel.isOpen).toBe(false)
    panel.toggle()
    expect(panel.activeView).toBe('problems')
    panel.hide()
    expect(tasks.isShown('problems')).toBe(false)
  })

  it('setTitle reaches the tab', () => {
    const { tasks, panel } = setup()
    for (const id of ['terminal', 'problems', 'output']) panel.addView(id, id, document.createElement('div'), document.createElement('div'))
    tasks.switchTo('code')
    panel.setTitle('problems', 'Problems (2)')
    expect(document.querySelector('.dock-tab[data-panel="problems"]')!.textContent).toContain('Problems (2)')
  })
})
