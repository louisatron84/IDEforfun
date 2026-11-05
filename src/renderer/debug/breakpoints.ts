/**
 * Breakpoints: which lines (0-based) of which files the debugger should stop
 * on. They follow edits, so a breakpoint stays on "its" code when lines are
 * added or removed above it.
 */
import type { Change } from '../editor/textBuffer'
import { isInside } from '../workspace'

const newlines = (text: string) => text.split('\n').length - 1

/** Where breakpoint lines end up after one edit. Result is sorted, without duplicates. */
export function shiftBreakpoints(lines: readonly number[], change: Change): number[] {
  const n = newlines(change.text)
  if (n === 0) return [...lines]
  const L = change.at.line
  const out: number[] = []
  if (change.kind === 'insert') {
    // Enter at the very start of a line pushes that line (and its breakpoint) down.
    for (const b of lines) out.push(b > L || (b === L && change.at.col === 0) ? b + n : b)
  } else if (change.at.col === 0 && change.text.endsWith('\n')) {
    // Whole lines L .. L+n-1 removed (e.g. cut line): their breakpoints go too.
    for (const b of lines) {
      if (b < L) out.push(b)
      else if (b >= L + n) out.push(b - n)
    }
  } else {
    // Lines L+1 .. L+n joined onto line L.
    for (const b of lines) out.push(b <= L ? b : b <= L + n ? L : b - n)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

const norm = (p: string) => (/^[a-zA-Z]:/.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p)

export class BreakpointStore {
  private readonly files = new Map<string, { path: string; lines: number[] }>()
  private readonly listeners = new Set<(path: string) => void>()

  /** Called with the file's path whenever its breakpoints change. */
  subscribe(listener: (path: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  linesFor(path: string): readonly number[] {
    return this.files.get(norm(path))?.lines ?? []
  }

  has(path: string, line: number): boolean {
    return this.linesFor(path).includes(line)
  }

  /** Every file that has breakpoints. */
  all(): { path: string; lines: readonly number[] }[] {
    return [...this.files.values()]
  }

  get count(): number {
    let n = 0
    for (const f of this.files.values()) n += f.lines.length
    return n
  }

  toggle(path: string, line: number): void {
    const lines = this.linesFor(path)
    this.set(path, lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line].sort((a, b) => a - b))
  }

  /** Keep breakpoints on their code after an edit to this file. */
  applyChange(path: string, change: Change): void {
    const lines = this.linesFor(path)
    if (!lines.length || newlines(change.text) === 0) return
    const next = shiftBreakpoints(lines, change)
    if (next.join() !== lines.join()) this.set(path, next)
  }

  /** A file or folder was renamed: move its breakpoints along. */
  pathRenamed(oldPath: string, newPath: string): void {
    for (const f of [...this.files.values()]) {
      if (!isInside(f.path, oldPath)) continue
      const moved = newPath + f.path.slice(oldPath.length)
      this.set(f.path, [])
      this.set(moved, f.lines)
    }
  }

  /** A file or folder was deleted. */
  removeUnder(path: string): void {
    for (const f of [...this.files.values()]) if (isInside(f.path, path)) this.set(f.path, [])
  }

  clear(): void {
    for (const f of [...this.files.values()]) this.set(f.path, [])
  }

  private set(path: string, lines: number[]): void {
    if (lines.length) this.files.set(norm(path), { path, lines })
    else this.files.delete(norm(path))
    for (const l of this.listeners) l(path)
  }
}
