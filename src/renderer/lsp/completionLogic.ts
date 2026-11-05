/** Pure helpers for autocomplete: what's being typed, filtering, and what to insert. */
import type { Position } from '../editor/textBuffer'
import { fuzzyMatch } from '../fuzzy'

export interface CompletionItem {
  label: string
  /** LSP CompletionItemKind (3 function, 6 variable, 7 class, 9 module, 14 keyword...) */
  kind?: number
  detail?: string
  documentation?: string
  insertText?: string
  filterText?: string
  sortText?: string
  textEdit?: { start: Position; end: Position; text: string }
  /** The raw item, for completionItem/resolve. */
  raw?: unknown
}

const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch)

/** Column where the identifier being typed (ending at `col`) starts. */
export function wordStartAt(lineText: string, col: number): number {
  let i = col
  while (i > 0 && isWordChar(lineText[i - 1])) i--
  return i
}

/** Items matching what was typed so far, best first (ties keep the server's order). */
export function filterCompletions(items: CompletionItem[], prefix: string): CompletionItem[] {
  const byServerOrder = (a: CompletionItem, b: CompletionItem) =>
    (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)
  if (!prefix) return [...items].sort(byServerOrder)
  const scored: { item: CompletionItem; score: number }[] = []
  for (const item of items) {
    const text = item.filterText ?? item.label
    const m = fuzzyMatch(prefix, text)
    if (!m) continue
    let score = m.score
    if (text === prefix) score += 100
    else if (text.startsWith(prefix)) score += 30 // same case as typed: "Do" prefers Dog over dog
    else if (text.toLowerCase().startsWith(prefix.toLowerCase())) score += 20
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || byServerOrder(a.item, b.item))
  return scored.map((s) => s.item)
}

/** The replacement to make when accepting `item` with the cursor at `pos` on `lineText`. */
export function completionEdit(
  item: CompletionItem, lineText: string, pos: Position
): { start: Position; end: Position; text: string } {
  if (item.textEdit) return { start: item.textEdit.start, end: pos, text: item.textEdit.text }
  const start = { line: pos.line, col: wordStartAt(lineText, pos.col) }
  return { start, end: pos, text: item.insertText ?? item.label }
}

/** Short symbol shown next to each suggestion. */
export function kindIcon(kind: number | undefined): { icon: string; name: string } {
  switch (kind) {
    case 2: return { icon: 'ƒ', name: 'method' }
    case 3: return { icon: 'ƒ', name: 'function' }
    case 4: return { icon: 'ƒ', name: 'constructor' }
    case 5: case 10: return { icon: '◇', name: 'property' }
    case 6: return { icon: 'x', name: 'variable' }
    case 7: case 22: return { icon: 'C', name: 'class' }
    case 9: return { icon: 'M', name: 'module' }
    case 14: return { icon: 'k', name: 'keyword' }
    case 21: return { icon: 'π', name: 'constant' }
    case 13: case 20: return { icon: 'E', name: 'enum' }
    default: return { icon: '·', name: 'text' }
  }
}
