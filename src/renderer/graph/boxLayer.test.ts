// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { newApiBox, newRequest, type ApiBox } from '../../shared/boxes'
import type { Layout } from './layout'
import { boxAnchor, boxBounds, boxSummary, boxTitle, drawBoxLayer, panToShow, placeBoxes } from './boxLayer'

function gh(): ApiBox {
  const box = newApiBox([], 'GitHub')
  box.attach = { module: 'app.api' }
  box.baseUrl = 'https://api.github.com'
  box.requests[0] = { ...box.requests[0], name: 'users', url: '/users', output: 'users.csv' }
  return box
}

const layout: Layout = {
  nodes: new Map([
    ['app.api', { x: 0, y: 0, width: 100, height: 40, layer: 0 }],
    ['app.api:github_users', { x: 0, y: 100, width: 120, height: 40, layer: 0 }]
  ]),
  width: 300,
  height: 200
}

describe('where boxes go', () => {
  it('boxAnchor: the module, or the generated function in the Calls view', () => {
    const box = gh()
    const ids = new Set(['app.api', 'app.api:github_users'])
    expect(boxAnchor(box, 'modules', ids)).toBe('app.api')
    expect(boxAnchor(box, 'calls', ids)).toBe('app.api:github_users')
    expect(boxAnchor(box, 'calls', new Set(['app.api']))).toBe('app.api')
    expect(boxAnchor(box, 'modules', new Set())).toBeNull()
    expect(boxAnchor({ ...box, attach: null }, 'modules', ids)).toBeNull()
  })

  it('placeBoxes: right of the anchor, stacked, unanchored ones right of everything', () => {
    const a = gh()
    const b = { ...gh(), id: 'b' }
    const c = { ...gh(), id: 'c', attach: null }
    const placed = placeBoxes(layout, [a, b, c], 'modules', new Set(['app.api']))
    const pa = placed.get(a.id)!
    const pb = placed.get('b')!
    const pc = placed.get('c')!
    expect(pa.x).toBe(124)
    expect(pa.y).toBe(0)
    expect(pa.anchor).toBe('app.api')
    expect(pb.x).toBe(124)
    expect(pb.y).toBeGreaterThanOrEqual(pa.y + pa.height + 8)
    expect(pc.x).toBeGreaterThan(300)
    expect(pc.anchor).toBeNull()
  })
})

describe('boxes never overlap', () => {
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  it('an unattached box goes right of attached ones, not on top of them', () => {
    const a = gh()
    const b = { ...gh(), id: 'b', attach: null }
    const wide: Layout = { nodes: new Map([['app.api', { x: 200, y: 0, width: 100, height: 40, layer: 1 }]]), width: 300, height: 40 }
    const placed = placeBoxes(wide, [a, b], 'modules', new Set(['app.api']))
    expect(overlap(placed.get(a.id)!, placed.get('b')!)).toBe(false)
  })

  it('boxes of neighbouring nodes are pushed down instead of overlapping', () => {
    const near: Layout = {
      nodes: new Map([
        ['m1', { x: 0, y: 0, width: 100, height: 40, layer: 0 }],
        ['m2', { x: 0, y: 50, width: 100, height: 40, layer: 0 }]
      ]),
      width: 100, height: 90
    }
    const a = { ...gh(), attach: { module: 'm1' } }
    const b = { ...gh(), id: 'b', attach: { module: 'm2' } }
    b.requests = [...b.requests, { ...b.requests[0], id: 'r2' }, { ...b.requests[0], id: 'r3' }]
    a.requests = [...a.requests, { ...a.requests[0], id: 'r2' }, { ...a.requests[0], id: 'r3' }]
    const placed = placeBoxes(near, [a, b], 'modules', new Set(['m1', 'm2']))
    expect(overlap(placed.get(a.id)!, placed.get('b')!)).toBe(false)
    expect(placed.get('b')!.anchor).toBe('m2')
  })

  it('boxBounds covers the graph and every box (for Fit)', () => {
    const c = { ...gh(), id: 'c', attach: null }
    const placed = placeBoxes(layout, [c], 'modules', new Set())
    const p = placed.get('c')!
    expect(boxBounds(layout, placed)).toEqual({ width: p.x + p.width, height: Math.max(layout.height, p.y + p.height) })
  })

  it('panToShow moves the view just enough to show a box', () => {
    const view = { x: 0, y: 0, k: 1 }
    expect(panToShow(view, { x: 10, y: 10, width: 50, height: 20 }, { width: 400, height: 300 })).toEqual(view)
    const moved = panToShow(view, { x: 600, y: 10, width: 100, height: 20 }, { width: 400, height: 300 })
    expect(moved.k).toBe(1)
    expect(600 + moved.x).toBeGreaterThanOrEqual(0)
    expect(700 + moved.x).toBeLessThanOrEqual(400)
  })
})

describe('box labels', () => {
  it('the title does not repeat API', () => {
    expect(boxTitle({ ...gh(), name: 'API' })).toBe('API')
    expect(boxTitle({ ...gh(), name: 'My api' })).toBe('My api')
    expect(boxTitle(gh())).toBe('GitHub · API')
  })

  it('ticked fields after a restart (no field list yet)', () => {
    const box = gh()
    const req = { ...box.requests[0], ticked: ['a', 'b'], test: { ok: true, at: 1 } }
    expect(boxSummary(box, req)).toBe('GET api.github.com/users → users.csv · 2 fields')
  })
})

describe('box summary', () => {
  it('before and after a test call', () => {
    const box = gh()
    expect(boxSummary(box, box.requests[0])).toBe('GET api.github.com/users → users.csv · not tested')
    const req = {
      ...box.requests[0],
      ticked: ['login', 'plan.name'],
      test: {
        ok: true, at: 1,
        fields: [
          { path: ['login'], name: 'login', kind: 'value' as const, sample: 'a', children: [] },
          { path: ['id'], name: 'id', kind: 'value' as const, sample: '1', children: [] },
          { path: ['plan'], name: 'plan', kind: 'object' as const, sample: '', children: [
            { path: ['plan', 'name'], name: 'name', kind: 'value' as const, sample: 'pro', children: [] },
            { path: ['plan', 'seats'], name: 'seats', kind: 'value' as const, sample: '1', children: [] }
          ] },
          { path: ['tags'], name: 'tags', kind: 'list' as const, sample: '[]', children: [] }
        ]
      }
    }
    expect(boxSummary(box, req)).toBe('GET api.github.com/users → users.csv · 2 of 5 fields')
    expect(boxSummary(box, { ...box.requests[0], url: '' })).toBe('GET (no URL yet) → users.csv · not tested')
  })
})

describe('drawing', () => {
  it('one box group per box, a line and dot per request, a wire to the anchor; live wires get a spark', () => {
    const box = gh()
    box.requests.push(newRequest(box, 'repos'))
    box.requests[0].test = { ok: true, at: 1, fields: [] }
    box.requests[1].test = { ok: false, at: 1, error: 'x' }
    const placed = placeBoxes(layout, [box], 'modules', new Set(['app.api']))
    const g = drawBoxLayer(layout, placed, [box], { selected: box.id, live: new Set([box.id]), reducedMotion: false })
    const el = g.querySelector('.gbox')!
    expect(el.getAttribute('data-box')).toBe(box.id)
    expect(el.classList.contains('selected')).toBe(true)
    expect(el.querySelectorAll('.gbox-line')).toHaveLength(2)
    expect([...el.querySelectorAll('.dot')].map((d) => d.getAttribute('class'))).toEqual(['dot ok', 'dot fail'])
    const wire = g.querySelector('.gbox-wire')!
    expect(wire.classList.contains('live')).toBe(true)
    expect(g.querySelector('.spark animateMotion')).not.toBeNull()
    const still = drawBoxLayer(layout, placed, [box], { selected: null, live: new Set([box.id]), reducedMotion: true })
    expect(still.querySelector('.spark animateMotion')).toBeNull()
  })
})
