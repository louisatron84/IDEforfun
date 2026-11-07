/**
 * The Project map (visual navigation): every Python file as a rectangle
 * sized by its lines, grouped by top folder. The open file, files with
 * problems, changed files and recently opened ones are marked; type to
 * find, click (or Enter) to open.
 */
import { projectMap, type MapFile } from '../shared/treemap'

export interface MapInfo {
  files: MapFile[]
  current: string | null
  /** Errors / warnings per file. */
  problems: ReadonlyMap<string, number>
  changed: ReadonlySet<string>
  recent: readonly string[]
  open(rel: string): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function showProjectMap(info: MapInfo): void {
  document.querySelector('.project-map-overlay')?.remove()
  const overlay = el('div', 'project-map-overlay')
  const dlg = el('div', 'project-map')
  dlg.setAttribute('role', 'dialog')
  dlg.setAttribute('aria-label', 'Project map')
  const head = el('div', 'project-map-head')
  const filter = el('input', 'project-map-filter')
  filter.placeholder = 'Find a file…'
  filter.setAttribute('aria-label', 'Find a file')
  const legend = el('span', 'project-map-legend')
  legend.append(el('span', 'pm-key current', 'open'), el('span', 'pm-key problem', 'problems'), el('span', 'pm-key changed', 'changed'), el('span', 'pm-key recent', 'recent'))
  const close = el('button', 'project-map-close', '✕')
  close.title = 'Close (Esc)'
  head.append(el('strong', '', 'Project map'), filter, legend, close)
  const board = el('div', 'project-map-board')
  const note = el('div', 'project-map-note', 'Each box is a Python file, sized by its lines and grouped by folder. Click one to open it.')
  dlg.append(head, board, note)
  overlay.append(dlg)
  document.body.append(overlay)

  const done = () => {
    window.removeEventListener('resize', draw)
    overlay.remove()
  }
  close.addEventListener('click', done)
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) done()
  })
  const recent = new Set(info.recent)
  const groupIndex = new Map<string, number>()

  function draw(): void {
    const w = board.clientWidth
    const h = board.clientHeight
    const map = projectMap(info.files, { x: 0, y: 0, w, h })
    const q = filter.value.trim().toLowerCase()
    const parts: HTMLElement[] = []
    for (const [g, r] of map.groups) {
      if (!groupIndex.has(g)) groupIndex.set(g, groupIndex.size)
      const box = el('div', 'pm-group')
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
      if (r.h > 20 && r.w > 40) box.append(el('span', 'pm-group-label', g ? `${g}/` : '(top level)'))
      parts.push(box)
    }
    for (const f of info.files) {
      const r = map.files.get(f.path)
      if (!r) continue
      const g = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : ''
      const tile = el('button', 'pm-file')
      const cls = [
        f.path === info.current ? 'current' : '', (info.problems.get(f.path) ?? 0) > 0 ? 'problem' : '',
        info.changed.has(f.path) ? 'changed' : '', recent.has(f.path) ? 'recent' : '',
        q && !f.path.toLowerCase().includes(q) ? 'dim' : ''
      ].filter(Boolean)
      tile.classList.add(...cls)
      // A shade per folder, from the theme's accent.
      tile.style.setProperty('--pm-mix', `${12 + ((groupIndex.get(g) ?? 0) * 13) % 36}%`)
      Object.assign(tile.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${Math.max(0, r.w - 1)}px`, height: `${Math.max(0, r.h - 1)}px` })
      const name = f.path.slice(f.path.lastIndexOf('/') + 1)
      if (r.w > 46 && r.h > 16) tile.append(el('span', 'pm-name', name))
      if (r.w > 46 && r.h > 32) tile.append(el('span', 'pm-lines', `${f.lines} lines`))
      const problems = info.problems.get(f.path) ?? 0
      tile.title = `${f.path} · ${f.lines} lines${problems ? ` · ${problems} problem${problems === 1 ? '' : 's'}` : ''}${info.changed.has(f.path) ? ' · changed' : ''}`
      tile.addEventListener('click', () => {
        done()
        info.open(f.path)
      })
      parts.push(tile)
    }
    board.replaceChildren(...parts)
  }

  filter.addEventListener('input', draw)
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      done()
    } else if (e.key === 'Enter') {
      const q = filter.value.trim().toLowerCase()
      const hit = q ? info.files.find((f) => f.path.toLowerCase().includes(q)) : undefined
      if (hit) {
        done()
        info.open(hit.path)
      }
    }
  })
  window.addEventListener('resize', draw)
  requestAnimationFrame(draw)
  filter.focus()
}
