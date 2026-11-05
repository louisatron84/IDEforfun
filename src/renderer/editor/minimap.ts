/**
 * The minimap: a zoomed-out picture of the whole file on the right edge of
 * the editor, with a box showing the part that's on screen. Click or drag
 * it to scroll.
 *
 * Each line is drawn as thin colored bars (one per token) on a canvas. When
 * the file has more lines than the minimap has pixels, lines are sampled,
 * so drawing costs the same for a 100-line file and a 100k-line one.
 */
import type { Token } from './tokenizer'

export const MINIMAP_WIDTH = 90

export interface MinimapSource {
  /** Rows on screen (lines minus folded ones). */
  rowCount(): number
  lineAtRow(row: number): number
  getLine(line: number): string
  /** Tokens if they're cheap to get right now, else null (the line is drawn in one color). */
  tokens(line: number): Token[] | null
  /** Do some highlighting work in spare time; true if there's more to do. */
  warmUp(budgetMs: number, upToLine: number): boolean
  /** The editor's scroll position and size, in pixels, and the height of one row. */
  scroll(): { top: number; height: number; rowHeight: number }
  /** Scroll so that `row` is in the middle of the editor. */
  scrollToRow(row: number): void
}

/** Pixels per row in the minimap when the whole file fits. */
const ROW_PX = 2
const CHAR_PX = 1

export class Minimap {
  readonly canvas: HTMLCanvasElement
  private frame = 0
  private idle = 0
  private visible = true

  constructor(private readonly source: MinimapSource) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'minimap'
    this.canvas.title = 'Click or drag to scroll'
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e))
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.canvas.hidden = !visible
    if (visible) this.schedule()
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** Redraw on the next animation frame (many calls in a row draw once). */
  schedule(): void {
    if (!this.visible || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  /** How many minimap pixels one row takes (smaller than ROW_PX for long files). */
  private rowScale(height: number): number {
    const rows = Math.max(1, this.source.rowCount())
    return Math.min(ROW_PX, height / rows)
  }

  private draw(): void {
    const c = this.canvas
    const cssW = c.clientWidth
    const cssH = c.clientHeight
    if (!cssW || !cssH) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr)
      c.height = Math.round(cssH * dpr)
    }
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const style = getComputedStyle(c)
    const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    const textColor = color('--fg', '#ccc')
    const tokenColors: Record<string, string> = {}
    for (const t of ['keyword', 'constant', 'builtin', 'self', 'function', 'class', 'call', 'decorator', 'string', 'number', 'comment']) {
      tokenColors[t] = color(`--tok-${t}`, textColor)
    }

    const rows = this.source.rowCount()
    const scale = this.rowScale(cssH)
    const barH = Math.max(1, Math.min(scale, ROW_PX) * 0.75)
    const pixelRows = Math.min(rows, Math.ceil(rows * scale))
    ctx.globalAlpha = 0.75
    let missing = -1 // last line drawn without colors (highlighting not computed yet)
    for (let py = 0; py < pixelRows; py += Math.max(1, scale)) {
      const row = Math.min(rows - 1, Math.floor(py / scale))
      const line = this.source.lineAtRow(row)
      const text = this.source.getLine(line)
      if (!text.trim()) continue
      const y = row * scale
      let pos = 0
      const drawRun = (from: number, to: number, fill: string) => {
        // Skip leading spaces inside the run so indentation shows.
        let start = from
        while (start < to && (text[start] === ' ' || text[start] === '\t')) start++
        if (start >= to) return
        ctx.fillStyle = fill
        ctx.fillRect(4 + start * CHAR_PX, y, Math.min(to - start, 200) * CHAR_PX, barH)
      }
      const tokens = this.source.tokens(line)
      if (!tokens) missing = line
      for (const tok of tokens ?? []) {
        if (tok.start > pos) drawRun(pos, tok.start, textColor)
        drawRun(tok.start, tok.end, tokenColors[tok.type] ?? textColor)
        pos = tok.end
      }
      if (pos < text.length) drawRun(pos, text.length, textColor)
    }

    // The part of the file that's on screen.
    const { top, height, rowHeight } = this.source.scroll()
    const y = (top / rowHeight) * scale
    const h = Math.max(8, (height / rowHeight) * scale)
    ctx.globalAlpha = 1
    ctx.fillStyle = color('--minimap-view', 'rgba(127,127,127,0.18)')
    ctx.fillRect(0, y, cssW, h)

    // Some lines had no colors yet: highlight them in spare moments, then redraw.
    if (missing >= 0 && !this.idle) {
      const work = () => {
        this.idle = 0
        const more = this.source.warmUp(8, missing)
        if (more) this.idle = window.setTimeout(work, 30)
        else this.schedule()
      }
      this.idle = window.setTimeout(work, 120)
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    e.preventDefault()
    const scrollTo = (ev: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect()
      const scale = this.rowScale(rect.height)
      const row = Math.floor((ev.clientY - rect.top) / scale)
      this.source.scrollToRow(Math.max(0, Math.min(this.source.rowCount() - 1, row)))
    }
    scrollTo(e)
    const onMove = (ev: MouseEvent) => scrollTo(ev)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
}
