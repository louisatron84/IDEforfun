// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { DockView } from './dockView'
import { defaultArrangement, findStack, PANEL_IDS, type DockNode, type SplitNode } from './model'

function setup() {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  document.body.append(container)
  const hooks = { changed: vi.fn(), closePanel: vi.fn(), drop: vi.fn() }
  const view = new DockView(container, hooks)
  const bodies: Record<string, HTMLElement> = {}
  const shown: Record<string, number> = {}
  for (const id of PANEL_IDS) {
    const body = document.createElement('div')
    body.className = `body-${id}`
    bodies[id] = body
    shown[id] = 0
    view.register({ id, title: id[0].toUpperCase() + id.slice(1), body, onShow: () => shown[id]++, closable: id !== 'editor' })
  }
  return { container, view, hooks, bodies, shown }
}

describe('DockView', () => {
  it('a floating panel counts as shown, is left where it is by redraws, and comes back hidden', () => {
    const { view, bodies } = setup()
    const elsewhere = document.createElement('div')
    document.body.append(elsewhere)
    let focused = 0
    view.setFloating('outline', () => focused++)
    elsewhere.append(bodies.outline)
    view.render(defaultArrangement('code'))
    expect(bodies.outline.parentElement).toBe(elsewhere)
    expect(view.isShown('outline')).toBe(true)
    view.focusFloating('outline')
    expect(focused).toBe(1)
    view.setFloating('outline', null)
    expect(view.isFloating('outline')).toBe(false)
    expect(bodies.outline.parentElement).not.toBe(elsewhere)
    expect(bodies.outline.hidden).toBe(true)
  })

  it('panels other than the editor and terminal get a ⧉ button when floating is possible', () => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    document.body.append(container)
    const floated: string[] = []
    const view = new DockView(container, { changed: vi.fn(), closePanel: vi.fn(), drop: vi.fn(), floatPanel: (id) => floated.push(id) })
    for (const id of PANEL_IDS) view.register({ id, title: id, body: document.createElement('div') })
    view.render(defaultArrangement('code'))
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.dock-float')]
    expect(buttons.length).toBe(3) // files, where and infile; not the editor or the terminal
    buttons[0].click()
    expect(floated).toEqual(['files'])
  })
  it('a collapsed stack gives its space back to the rest of the split', () => {
    const { container, view } = setup()
    const root = defaultArrangement('code')
    const drawer = findStack(root, 'terminal')!
    drawer.collapsed = true
    view.render(root)
    const cell = (container.querySelector(`[data-stack="${drawer.id}"]`) as HTMLElement).parentElement as HTMLElement
    expect(cell.style.flex).toBe('0 0 auto')
  })

  it('scroll positions inside panels survive a re-render', () => {
    const { view, bodies } = setup()
    const inner = document.createElement('div')
    bodies.editor.append(inner)
    view.render(defaultArrangement('code'))
    inner.scrollTop = 240
    inner.dispatchEvent(new Event('scroll'))
    inner.scrollTop = 0 // what the browser does when the element is moved
    view.render(defaultArrangement('debug'))
    expect(inner.scrollTop).toBe(240)
  })

  it('moves the same panel elements between arrangements and calls onShow when they reappear', () => {
    const { container, view, bodies, shown } = setup()
    view.render(defaultArrangement('code'))
    const editor = bodies.editor
    expect(container.contains(editor)).toBe(true)
    expect(shown.editor).toBe(1)
    view.render(defaultArrangement('connect'))
    expect(view.isShown('editor')).toBe(false)
    view.render(defaultArrangement('code'))
    expect(container.querySelector('.body-editor')).toBe(editor)
    expect(shown.editor).toBe(2)
  })

  it('only the active panel of a stack is visible', () => {
    const { view, bodies } = setup()
    view.render(defaultArrangement('code'))
    expect(bodies.files.hidden).toBe(false)
    expect(bodies.git.hidden).toBe(true)
    expect(view.isShown('git')).toBe(false)
  })

  it('unplaced panels wait hidden in the store', () => {
    const { view, bodies } = setup()
    view.render(defaultArrangement('connect'))
    expect(bodies.debug.hidden).toBe(true)
    expect(bodies.debug.closest('.dock-store')).not.toBeNull()
    expect(view.isShown('debug')).toBe(false)
  })

  it('setTitle updates the tab', () => {
    const { container, view } = setup()
    view.render(defaultArrangement('code'))
    view.setTitle('problems', 'Problems (3)')
    expect(container.querySelector('.dock-tab[data-panel="problems"]')!.textContent).toContain('Problems (3)')
  })

  it('clicking a tab activates it and reports the new arrangement', () => {
    const { container, view, hooks, bodies } = setup()
    view.render(defaultArrangement('code'))
    ;(container.querySelector('.dock-tab[data-panel="git"]') as HTMLElement).click()
    expect(bodies.git.hidden).toBe(false)
    const root = hooks.changed.mock.calls.at(-1)![0] as DockNode
    expect(findStack(root, 'git')!.active).toBe('git')
  })

  it('in edit mode, closable tabs get a close button; the editor does not', () => {
    const { container, view, hooks } = setup()
    view.render(defaultArrangement('code'))
    expect(container.querySelector('.dock-tab-close')).toBeNull()
    view.editing = true
    expect(container.querySelector('.dock-tab[data-panel="editor"] .dock-tab-close')).toBeNull()
    ;(container.querySelector('.dock-tab[data-panel="where"] .dock-tab-close') as HTMLElement).click()
    expect(hooks.closePanel).toHaveBeenCalledWith('where')
  })

  it('dragging a divider reports once, on release, with sizes still summing to 1', () => {
    const { container, view, hooks } = setup()
    view.render(defaultArrangement('code'))
    const divider = container.querySelector('.dock-divider') as HTMLElement
    divider.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 140, clientY: 0 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 180, clientY: 0 }))
    expect(hooks.changed).not.toHaveBeenCalled()
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 180, clientY: 0 }))
    expect(hooks.changed).toHaveBeenCalledTimes(1)
    const root = hooks.changed.mock.calls[0][0] as SplitNode
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('in edit mode, dragging a tab onto the right half of a stack drops it there', () => {
    const { container, view, hooks } = setup()
    view.render(defaultArrangement('code'))
    view.editing = true
    const editorStack = container.querySelector('.dock-tab[data-panel="editor"]')!.closest('.dock-stack') as HTMLElement
    editorStack.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const tab = container.querySelector('.dock-tab[data-panel="problems"]') as HTMLElement
    tab.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }))
    editorStack.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 50, bubbles: true }))
    expect(editorStack.querySelector('.dock-drop.zone-right')).not.toBeNull()
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 90, clientY: 50 }))
    expect(hooks.drop).toHaveBeenCalledWith('problems', editorStack.dataset.stack, 'right')
    expect(container.querySelector('.dock-drop')).toBeNull()
  })

  it('outside edit mode, tabs do not start drags', () => {
    const { container, view, hooks } = setup()
    view.render(defaultArrangement('code'))
    const editorStack = container.querySelector('.dock-tab[data-panel="editor"]')!.closest('.dock-stack') as HTMLElement
    const tab = container.querySelector('.dock-tab[data-panel="problems"]') as HTMLElement
    tab.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }))
    editorStack.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 50, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 90, clientY: 50 }))
    expect(hooks.drop).not.toHaveBeenCalled()
  })
})

