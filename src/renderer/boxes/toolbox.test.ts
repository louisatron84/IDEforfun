// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { BOX_DRAG_TYPE, Toolbox } from './toolbox'

describe('Toolbox', () => {
  it('API is enabled and adds a box; the others are coming later', () => {
    let added = 0
    const tb = new Toolbox({ add: () => added++ })
    const items = [...tb.body.querySelectorAll('button')]
    expect(items.map((b) => b.dataset.type)).toEqual(['api', 'database', 'file', 'schedule'])
    items[0].click()
    expect(added).toBe(1)
    for (const b of items.slice(1)) {
      expect(b.disabled).toBe(true)
      expect(b.textContent).toContain('coming later')
    }
  })

  it('API can be dragged onto the graph', () => {
    const tb = new Toolbox({ add: () => {} })
    const api = tb.body.querySelector('button')!
    expect(api.draggable).toBe(true)
    const data = new Map<string, string>()
    const e = new Event('dragstart') as DragEvent
    Object.defineProperty(e, 'dataTransfer', { value: { setData: (t: string, v: string) => data.set(t, v), effectAllowed: '' } })
    api.dispatchEvent(e)
    expect(data.get(BOX_DRAG_TYPE)).toBe('api')
  })
})
