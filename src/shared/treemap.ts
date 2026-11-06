/**
 * A squarified treemap: rectangles with areas in proportion to their
 * weights, kept as close to square as possible (Bruls, Huizing and van Wijk).
 * Used by the Project map: files sized by their lines, grouped by folder.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Item {
  id: string
  weight: number
}

/** Rectangles for the items inside `area` (items with no weight get none). */
export function squarify(items: readonly Item[], area: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const list = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight)
  const total = list.reduce((n, i) => n + i.weight, 0)
  if (!list.length || area.w <= 0 || area.h <= 0) return out
  const scale = (area.w * area.h) / total
  let rect = { ...area }
  let row: { id: string; a: number }[] = []
  const worst = (r: { a: number }[], side: number) => {
    const sum = r.reduce((n, x) => n + x.a, 0)
    const max = Math.max(...r.map((x) => x.a))
    const min = Math.min(...r.map((x) => x.a))
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
  }
  const layoutRow = (r: { id: string; a: number }[]) => {
    const sum = r.reduce((n, x) => n + x.a, 0)
    if (rect.w >= rect.h) {
      // A column on the left.
      const w = sum / rect.h
      let y = rect.y
      for (const x of r) {
        const h = x.a / w
        out.set(x.id, { x: rect.x, y, w, h })
        y += h
      }
      rect = { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h }
    } else {
      const h = sum / rect.w
      let x0 = rect.x
      for (const x of r) {
        const w = x.a / h
        out.set(x.id, { x: x0, y: rect.y, w, h })
        x0 += w
      }
      rect = { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h }
    }
  }
  for (const item of list) {
    const a = item.weight * scale
    const side = Math.min(rect.w, rect.h)
    if (row.length && worst([...row, { id: item.id, a }], side) > worst(row, side)) {
      layoutRow(row)
      row = []
    }
    row.push({ id: item.id, a })
  }
  if (row.length) layoutRow(row)
  return out
}

export interface MapFile {
  path: string
  lines: number
}

/** Files grouped by their top folder: a rectangle per folder, and one per file inside it (with room for a label). */
export function projectMap(files: readonly MapFile[], area: Rect, header = 16, pad = 2): { groups: Map<string, Rect>; files: Map<string, Rect> } {
  const groupOf = (p: string) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')
  const byGroup = new Map<string, MapFile[]>()
  for (const f of files) {
    const g = groupOf(f.path)
    let list = byGroup.get(g)
    if (!list) byGroup.set(g, (list = []))
    list.push(f)
  }
  const weight = (f: MapFile) => Math.max(1, f.lines)
  const groups = squarify([...byGroup].map(([id, list]) => ({ id, weight: list.reduce((n, f) => n + weight(f), 0) })), area)
  const out = new Map<string, Rect>()
  for (const [g, rect] of groups) {
    // Too small for a label: the files use the whole folder rectangle.
    const roomy = rect.w > pad * 2 + 4 && rect.h > header + pad + 4
    const inner = roomy ? { x: rect.x + pad, y: rect.y + header, w: rect.w - pad * 2, h: rect.h - header - pad } : rect
    for (const [id, r] of squarify(byGroup.get(g)!.map((f) => ({ id: f.path, weight: weight(f) })), inner)) out.set(id, r)
  }
  return { groups, files: out }
}
