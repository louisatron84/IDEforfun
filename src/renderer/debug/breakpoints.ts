/**
 * Breakpoints: where the debugger should stop (0-based lines per file), each
 * with optional extras: a condition (`x > 10`), a hit count (`>= 3`), a log
 * message instead of stopping (`x is {x}`), and on/off. They follow edits,
 * so a breakpoint stays on "its" code when lines are added or removed above it.
 */
import type { Change } from '../editor/textBuffer'
import { shiftLines } from '../editor/lines'
import { isInside } from '../workspace'

export interface Breakpoint {
  line: number
  /** Stop only when this Python expression is true. */
  condition?: string
  /** Stop only on some hits: "3" (the 3rd), ">= 5", "% 2" (every 2nd)... */
  hitCondition?: string
  /** Don't stop: print this instead ({expressions} are filled in). */
  logMessage?: string
  enabled: boolean
}

/** A breakpoint as saved with the project. */
export interface SavedBreakpoint extends Breakpoint {
  path: string
}

const norm = (p: string) => (/^[a-zA-Z]:/.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p)
const clean = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined)

export class BreakpointStore {
  private readonly files = new Map<string, { path: string; bps: Breakpoint[] }>()
  private readonly listeners = new Set<(path: string) => void>()

  /** Called with the file's path whenever its breakpoints change. */
  subscribe(listener: (path: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Lines with a breakpoint (on or off) in a file. */
  linesFor(path: string): readonly number[] {
    return this.breakpointsFor(path).map((b) => b.line)
  }

  breakpointsFor(path: string): readonly Breakpoint[] {
    return this.files.get(norm(path))?.bps ?? []
  }

  get(path: string, line: number): Breakpoint | undefined {
    return this.breakpointsFor(path).find((b) => b.line === line)
  }

  has(path: string, line: number): boolean {
    return !!this.get(path, line)
  }

  /** Every file that has breakpoints. */
  all(): { path: string; lines: readonly number[]; breakpoints: readonly Breakpoint[] }[] {
    return [...this.files.values()].map((f) => ({ path: f.path, lines: f.bps.map((b) => b.line), breakpoints: f.bps }))
  }

  /** Breakpoints that are switched on (what "Run with breakpoints debugs" counts). */
  get count(): number {
    let n = 0
    for (const f of this.files.values()) n += f.bps.filter((b) => b.enabled).length
    return n
  }

  get total(): number {
    let n = 0
    for (const f of this.files.values()) n += f.bps.length
    return n
  }

  toggle(path: string, line: number): void {
    const bps = this.breakpointsFor(path)
    this.set(path, bps.some((b) => b.line === line) ? bps.filter((b) => b.line !== line) : [...bps, { line, enabled: true }])
  }

  /** Change a breakpoint's extras (creating it if there isn't one on that line). */
  update(path: string, line: number, patch: Partial<Omit<Breakpoint, 'line'>>): void {
    const bps = this.breakpointsFor(path)
    const old = bps.find((b) => b.line === line) ?? { line, enabled: true }
    const next: Breakpoint = { line, enabled: patch.enabled ?? old.enabled }
    const condition = 'condition' in patch ? clean(patch.condition) : old.condition
    const hitCondition = 'hitCondition' in patch ? clean(patch.hitCondition) : old.hitCondition
    const logMessage = 'logMessage' in patch ? clean(patch.logMessage) : old.logMessage
    if (condition) next.condition = condition
    if (hitCondition) next.hitCondition = hitCondition
    if (logMessage) next.logMessage = logMessage
    this.set(path, [...bps.filter((b) => b.line !== line), next])
  }

  remove(path: string, line: number): void {
    this.set(path, this.breakpointsFor(path).filter((b) => b.line !== line))
  }

  /** Switch every breakpoint on or off. */
  setAllEnabled(enabled: boolean): void {
    for (const f of [...this.files.values()]) this.set(f.path, f.bps.map((b) => ({ ...b, enabled })))
  }

  /** Keep breakpoints on their code after an edit to this file. */
  applyChange(path: string, change: Change): void {
    const bps = this.breakpointsFor(path)
    if (!bps.length || !change.text.includes('\n')) return
    const next: Breakpoint[] = []
    for (const b of bps) {
      const [line] = shiftLines([b.line], change)
      // Removed with its line, or merged onto a line that already has one.
      if (line === undefined || next.some((n) => n.line === line)) continue
      next.push({ ...b, line })
    }
    if (next.length !== bps.length || next.some((b, i) => b.line !== bps[i].line)) this.set(path, next)
  }

  /** A file or folder was renamed: move its breakpoints along. */
  pathRenamed(oldPath: string, newPath: string): void {
    for (const f of [...this.files.values()]) {
      if (!isInside(f.path, oldPath)) continue
      const moved = newPath + f.path.slice(oldPath.length)
      this.set(f.path, [])
      this.set(moved, f.bps)
    }
  }

  /** A file or folder was deleted. */
  removeUnder(path: string): void {
    for (const f of [...this.files.values()]) if (isInside(f.path, path)) this.set(f.path, [])
  }

  clear(): void {
    for (const f of [...this.files.values()]) this.set(f.path, [])
  }

  /** Everything, for saving with the project. */
  save(): SavedBreakpoint[] {
    return [...this.files.values()].flatMap((f) => f.bps.map((b) => ({ path: f.path, ...b })))
  }

  /** Replace everything with saved breakpoints (e.g. when a project is opened). */
  load(saved: readonly SavedBreakpoint[]): void {
    this.clear()
    const byFile = new Map<string, { path: string; bps: Breakpoint[] }>()
    for (const s of saved) {
      const f = byFile.get(norm(s.path)) ?? { path: s.path, bps: [] }
      if (f.bps.some((b) => b.line === s.line)) continue
      const { path: _path, ...bp } = s
      f.bps.push(bp)
      byFile.set(norm(s.path), f)
    }
    for (const f of byFile.values()) this.set(f.path, f.bps)
  }

  private set(path: string, bps: Breakpoint[]): void {
    const sorted = [...bps].sort((a, b) => a.line - b.line)
    if (sorted.length) this.files.set(norm(path), { path, bps: sorted })
    else if (!this.files.delete(norm(path))) return
    for (const l of this.listeners) l(path)
  }
}

/** Kept for older imports: breakpoints move like any other line markers. */
export const shiftBreakpoints = shiftLines

/** The kind of dot to draw for a breakpoint. */
export function breakpointStyle(b: Breakpoint): 'plain' | 'conditional' | 'log' | 'disabled' {
  if (!b.enabled) return 'disabled'
  if (b.logMessage) return 'log'
  if (b.condition || b.hitCondition) return 'conditional'
  return 'plain'
}
