/**
 * Reading the language server's answers for find references, rename and
 * document symbols (the outline), plus applying text edits to a whole file.
 * Pure functions, so they're easy to test.
 */
import type { Position } from '../editor/textBuffer'
import { uriToPath } from '../../shared/uri'

export interface Location {
  path: string
  start: Position
  end: Position
}

export interface TextEdit {
  start: Position
  end: Position
  text: string
}

/** A rename's changes: file path → edits in that file. */
export type FileEdits = Map<string, TextEdit[]>

export interface DocSymbol {
  name: string
  /** LSP SymbolKind (5 class, 6 method, 12 function, 13 variable, 14 constant...). */
  kind: number
  detail?: string
  /** The whole thing (e.g. the full function). */
  start: Position
  end: Position
  /** Just the name (where to put the cursor). */
  nameStart: Position
  children: DocSymbol[]
}

type LspPos = { line: number; character: number }
type LspRange = { start: LspPos; end: LspPos }
const pos = (p: LspPos): Position => ({ line: p.line, col: p.character })
const isRange = (r: unknown): r is LspRange =>
  !!r && typeof r === 'object' && typeof (r as LspRange).start?.line === 'number' && typeof (r as LspRange).end?.line === 'number'

/** Location[] / LocationLink[] → locations, sorted by file then position. */
export function parseLocations(res: unknown): Location[] {
  const list = Array.isArray(res) ? res : res ? [res] : []
  const out: Location[] = []
  for (const l of list) {
    const uri = l?.uri ?? l?.targetUri
    const range = l?.range ?? l?.targetSelectionRange ?? l?.targetRange
    if (typeof uri !== 'string' || !isRange(range)) continue
    out.push({ path: uriToPath(uri), start: pos(range.start), end: pos(range.end) })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.start.line - b.start.line || a.start.col - b.start.col)
}

/** A WorkspaceEdit (changes or documentChanges) → edits per file. File create/rename/delete operations are left out. */
export function parseWorkspaceEdit(res: unknown): FileEdits {
  const out: FileEdits = new Map()
  const add = (uri: unknown, edits: unknown) => {
    if (typeof uri !== 'string' || !Array.isArray(edits)) return
    const path = uriToPath(uri)
    const list = out.get(path) ?? []
    for (const e of edits) {
      if (!isRange(e?.range) || typeof e.newText !== 'string') continue
      list.push({ start: pos(e.range.start), end: pos(e.range.end), text: e.newText })
    }
    if (list.length) out.set(path, list)
  }
  const r = (res ?? {}) as { changes?: Record<string, unknown>; documentChanges?: unknown[] }
  if (Array.isArray(r.documentChanges)) {
    for (const dc of r.documentChanges as { textDocument?: { uri?: unknown }; edits?: unknown }[]) {
      if (dc?.textDocument) add(dc.textDocument.uri, dc.edits)
    }
  } else if (r.changes && typeof r.changes === 'object') {
    for (const [uri, edits] of Object.entries(r.changes)) add(uri, edits)
  }
  return out
}

/** DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat) → a symbol tree. */
export function parseSymbols(res: unknown): DocSymbol[] {
  if (!Array.isArray(res)) return []
  const one = (s: any): DocSymbol | null => {
    if (typeof s?.name !== 'string' || typeof s.kind !== 'number') return null
    const range = isRange(s.range) ? s.range : isRange(s.location?.range) ? s.location.range : null
    if (!range) return null
    const sel = isRange(s.selectionRange) ? s.selectionRange : range
    const sym: DocSymbol = {
      name: s.name, kind: s.kind, start: pos(range.start), end: pos(range.end), nameStart: pos(sel.start),
      children: Array.isArray(s.children) ? s.children.map(one).filter((c: DocSymbol | null): c is DocSymbol => !!c) : []
    }
    if (typeof s.detail === 'string' && s.detail) sym.detail = s.detail
    return sym
  }
  const list = res.map(one).filter((s): s is DocSymbol => !!s)
  const sortTree = (l: DocSymbol[]) => {
    l.sort((a, b) => a.start.line - b.start.line || a.start.col - b.start.col)
    for (const s of l) sortTree(s.children)
  }
  sortTree(list)
  return list
}

/** The innermost symbol containing `p` (a path from the outermost), for highlighting in the outline. */
export function symbolPathAt(symbols: DocSymbol[], p: Position): DocSymbol[] {
  const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.col <= b.col)
  for (const s of symbols) {
    if (before(s.start, p) && before(p, s.end)) return [s, ...symbolPathAt(s.children, p)]
  }
  return []
}

/**
 * Apply edits to a file's whole text (for files that aren't open). Keeps the
 * file's own line endings: positions count lines however they end.
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\r' && text[i + 1] === '\n') {
      lineStarts.push(i + 2)
      i++
    } else if (c === '\n' || c === '\r') lineStarts.push(i + 1)
  }
  const lineEnd = (line: number) => {
    if (line + 1 >= lineStarts.length) return text.length
    const next = lineStarts[line + 1]
    return text[next - 2] === '\r' && text[next - 1] === '\n' ? next - 2 : next - 1
  }
  const offset = (p: Position) => {
    if (p.line >= lineStarts.length) return text.length
    return Math.min(lineStarts[p.line] + p.col, lineEnd(p.line))
  }
  // Apply from the end so earlier offsets stay valid.
  const sorted = edits.map((e) => ({ from: offset(e.start), to: offset(e.end), text: e.text })).sort((a, b) => b.from - a.from || b.to - a.to)
  let out = text
  for (const e of sorted) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}

/** Short words for symbol kinds (shown in the outline). */
export const SYMBOL_KIND: Record<number, { icon: string; name: string }> = {
  2: { icon: '▣', name: 'module' },
  5: { icon: 'C', name: 'class' },
  6: { icon: 'ƒ', name: 'method' },
  7: { icon: '·', name: 'property' },
  8: { icon: '·', name: 'field' },
  9: { icon: 'ƒ', name: 'constructor' },
  12: { icon: 'ƒ', name: 'function' },
  13: { icon: 'x', name: 'variable' },
  14: { icon: 'K', name: 'constant' }
}

/** A function/method in a call hierarchy (the server's item is kept for follow-up requests). */
export interface CallItem {
  name: string
  kind: number
  detail?: string
  path: string
  start: Position
  end: Position
  nameStart: Position
  raw: unknown
}

export function parseCallItem(raw: any): CallItem | null {
  if (typeof raw?.name !== 'string' || typeof raw.uri !== 'string' || !isRange(raw.range)) return null
  const sel = isRange(raw.selectionRange) ? raw.selectionRange : raw.range
  const item: CallItem = {
    name: raw.name, kind: typeof raw.kind === 'number' ? raw.kind : 12, path: uriToPath(raw.uri),
    start: pos(raw.range.start), end: pos(raw.range.end), nameStart: pos(sel.start), raw
  }
  if (typeof raw.detail === 'string' && raw.detail) item.detail = raw.detail
  return item
}

/** Incoming ({from}) or outgoing ({to}) calls → the other end, with where the calls are. */
export function parseCalls(res: unknown, side: 'from' | 'to'): { item: CallItem; at: Position[] }[] {
  if (!Array.isArray(res)) return []
  const out: { item: CallItem; at: Position[] }[] = []
  for (const c of res) {
    const item = parseCallItem(c?.[side])
    if (!item) continue
    const at = Array.isArray(c.fromRanges) ? c.fromRanges.filter(isRange).map((r: LspRange) => pos(r.start)) : []
    out.push({ item, at })
  }
  return out.sort((a, b) => a.item.path.localeCompare(b.item.path) || a.item.nameStart.line - b.item.nameStart.line)
}

/** documentHighlight → ranges (kind 3 = write). */
export function parseHighlights(res: unknown): { start: Position; end: Position; write: boolean }[] {
  if (!Array.isArray(res)) return []
  return res.filter((h) => isRange(h?.range)).map((h) => ({ start: pos(h.range.start), end: pos(h.range.end), write: h.kind === 3 }))
}

export interface WorkspaceSymbol {
  name: string
  kind: number
  container?: string
  location: Location
}

/** workspace/symbol → symbols with locations. */
export function parseWorkspaceSymbols(res: unknown): WorkspaceSymbol[] {
  if (!Array.isArray(res)) return []
  const out: WorkspaceSymbol[] = []
  for (const s of res) {
    const loc = parseLocations(s?.location ? [s.location] : [])[0]
    if (typeof s?.name !== 'string' || typeof s.kind !== 'number' || !loc) continue
    const sym: WorkspaceSymbol = { name: s.name, kind: s.kind, location: loc }
    if (typeof s.containerName === 'string' && s.containerName) sym.container = s.containerName
    out.push(sym)
  }
  return out
}

/**
 * If the name at `col` is one of the bases in a `class Name(Base, ...)` line,
 * the new class's name and where it is; otherwise null. (For finding subclasses.)
 */
export function subclassAt(line: string, col: number): { name: string; col: number } | null {
  const m = /^(\s*)class\s+([A-Za-z_]\w*)\s*\(/.exec(line)
  if (!m) return null
  const open = m[0].length - 1
  // The bases end at the matching ")" (they can contain calls like Generic[T]).
  let depth = 0
  let close = -1
  for (let i = open; i < line.length; i++) {
    if ('([{'.includes(line[i])) depth++
    else if (')]}'.includes(line[i]) && --depth === 0) {
      close = i
      break
    }
  }
  if (col <= open || (close !== -1 && col >= close)) return null
  // metaclass=Base is not inheritance.
  if (/\bmetaclass\s*=\s*$/.test(line.slice(open + 1, col))) return null
  return { name: m[2], col: line.indexOf(m[2], m[1].length + 5) }
}

/** The `def method` directly inside the class defined on `classLine`, or null. */
export function methodInClass(lines: readonly string[], classLine: number, method: string): { line: number; col: number } | null {
  const indentOf = (s: string) => s.length - s.trimStart().length
  const classIndent = indentOf(lines[classLine] ?? '')
  let bodyIndent: number | null = null
  const def = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${method.replace(/\W/g, '')})\\s*\\(`)
  for (let i = classLine + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim() || /^\s*#/.test(l)) continue
    const ind = indentOf(l)
    if (ind <= classIndent) break // end of the class
    bodyIndent ??= ind
    if (ind !== bodyIndent) continue // inside a method
    const m = def.exec(l)
    if (m) return { line: i, col: l.indexOf(m[2], m[1].length) }
  }
  return null
}
