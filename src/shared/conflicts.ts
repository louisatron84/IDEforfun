/**
 * Merge conflict blocks in a file:
 *
 *   <<<<<<< HEAD            (current: your side)
 *   ...
 *   ||||||| base            (optional: the common ancestor, with diff3 style)
 *   ...
 *   =======
 *   ...                     (incoming: the side being merged in)
 *   >>>>>>> feature
 */

export interface Conflict {
  /** Line of <<<<<<< (0-based). */
  start: number
  /** Line of ||||||| or null. */
  base: number | null
  /** Line of =======. */
  separator: number
  /** Line of >>>>>>>. */
  end: number
  currentLabel: string
  incomingLabel: string
}

export type Resolution = 'current' | 'incoming' | 'both' | 'none'

/** Every complete conflict block, top to bottom. */
export function findConflicts(lines: readonly string[]): Conflict[] {
  const out: Conflict[] = []
  let open: { start: number; label: string; base: number | null; separator: number | null } | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('<<<<<<<') && (l.length === 7 || l[7] === ' ')) {
      open = { start: i, label: l.slice(8).trim(), base: null, separator: null }
    } else if (!open) {
      continue
    } else if (l.startsWith('|||||||') && open.separator === null && (l.length === 7 || l[7] === ' ')) {
      open.base = i
    } else if (l === '=======' || (l.startsWith('=======') && l.slice(7).trim() === '')) {
      if (open.separator === null) open.separator = i
    } else if (l.startsWith('>>>>>>>') && (l.length === 7 || l[7] === ' ') && open.separator !== null) {
      out.push({ start: open.start, base: open.base, separator: open.separator, end: i, currentLabel: open.label, incomingLabel: l.slice(8).trim() })
      open = null
    }
  }
  return out
}

/** The lines that replace a conflict block (start..end inclusive) for a choice. */
export function resolveConflict(lines: readonly string[], c: Conflict, choice: Resolution): string[] {
  const current = lines.slice(c.start + 1, c.base ?? c.separator)
  const incoming = lines.slice(c.separator + 1, c.end)
  if (choice === 'current') return current
  if (choice === 'incoming') return incoming
  if (choice === 'both') return [...current, ...incoming]
  return []
}

/** The conflict the cursor is in, else the next one below it (wrapping to the first). */
export function conflictNear(conflicts: Conflict[], line: number): Conflict | null {
  return conflicts.find((c) => line >= c.start && line <= c.end) ?? conflicts.find((c) => c.start > line) ?? conflicts[0] ?? null
}
