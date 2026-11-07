import { describe, expect, it } from 'vitest'
import { projectMap, squarify } from './treemap'

const area = (r: { w: number; h: number }) => r.w * r.h
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6

describe('squarify', () => {
  it('areas are in proportion to the weights and fill the space', () => {
    const items = [6, 6, 4, 3, 2, 2, 1].map((weight, i) => ({ id: `i${i}`, weight }))
    const rects = squarify(items, { x: 0, y: 0, w: 600, h: 400 })
    const total = 600 * 400
    for (const it of items) expect(close(area(rects.get(it.id)!), (it.weight / 24) * total)).toBe(true)
    const sum = [...rects.values()].reduce((n, r) => n + area(r), 0)
    expect(close(sum, total)).toBe(true)
  })
  it('stays inside the area, with no overlaps', () => {
    const rects = [...squarify([5, 3, 3, 2, 1, 1, 1].map((weight, i) => ({ id: String(i), weight })), { x: 10, y: 20, w: 300, h: 200 }).values()]
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-9)
      expect(r.y).toBeGreaterThanOrEqual(20 - 1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(310 + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(220 + 1e-9)
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
      expect(overlap).toBeLessThan(1e-6)
    }
  })
  it('nothing to place, or no room: no rectangles', () => {
    expect(squarify([], { x: 0, y: 0, w: 10, h: 10 }).size).toBe(0)
    expect(squarify([{ id: 'a', weight: 0 }], { x: 0, y: 0, w: 10, h: 10 }).size).toBe(0)
    expect(squarify([{ id: 'a', weight: 1 }], { x: 0, y: 0, w: 0, h: 10 }).size).toBe(0)
  })
})

describe('projectMap', () => {
  it('a rectangle per top folder, and every file inside its folder', () => {
    const files = [{ path: 'app/a.py', lines: 300 }, { path: 'app/b.py', lines: 100 }, { path: 'tests/t.py', lines: 50 }, { path: 'main.py', lines: 0 }]
    const m = projectMap(files, { x: 0, y: 0, w: 800, h: 500 })
    expect([...m.groups.keys()].sort()).toEqual(['', 'app', 'tests'])
    for (const f of files) {
      const r = m.files.get(f.path)!
      const g = m.groups.get(f.path.includes('/') ? f.path.split('/')[0] : '')!
      expect(r.x).toBeGreaterThanOrEqual(g.x)
      expect(r.y).toBeGreaterThanOrEqual(g.y)
      expect(r.x + r.w).toBeLessThanOrEqual(g.x + g.w + 1e-9)
    }
  })
})
