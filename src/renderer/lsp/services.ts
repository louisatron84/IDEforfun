/**
 * The language services of the IDE: every language server (one LspServer
 * each), side by side. Callers ask about a document and this sends the
 * question to the server for that document's language; answers that span
 * the project (diagnostics, project symbols) are merged from all of them.
 * Diagnostics from other tools (Ruff) are kept here too and shown together
 * with the servers'.
 */
import type { Doc } from '../editor/document'
import type { Position } from '../editor/textBuffer'
import type { SemToken } from '../editor/semantic'
import type { CompletionItem } from './completionLogic'
import type { CallItem, DocSymbol, FileEdits, Location, WorkspaceSymbol } from './navigation'
import { pathKey, type CodeAction, type Diagnostic, type LspServer } from './server'

type FileDiagnostics = Map<string, { path: string; list: Diagnostic[] }>

export class LanguageServices {
  private readonly listeners = new Set<() => void>()
  /** Diagnostics from other tools (Ruff), per source and file. */
  private readonly external = new Map<string, FileDiagnostics>()

  constructor(readonly servers: readonly LspServer[]) {
    for (const s of servers) s.onDiagnostics(() => this.changed())
  }

  server(id: string): LspServer | undefined {
    return this.servers.find((s) => s.config.id === id)
  }

  /** The server for this document's language, if there is one and it's running. */
  serverFor(doc: Doc): LspServer | null {
    return this.servers.find((s) => s.knows(doc)) ?? null
  }

  /** Is some server looking after this doc (open, in its language, started)? */
  knows(doc: Doc): boolean {
    return this.serverFor(doc) !== null
  }

  /** Is any server running? */
  get isStarted(): boolean {
    return this.servers.some((s) => s.isStarted)
  }

  /** Applies edits a server asks for (workspace/applyEdit). */
  set applyEditHandler(handler: ((edits: FileEdits) => Promise<boolean> | boolean) | null) {
    for (const s of this.servers) s.applyEditHandler = handler
  }

  // ---------- documents ----------

  /** Match every server's open documents to the editor's tabs (each takes the ones in its languages). */
  syncDocs(docs: readonly Doc[]): void {
    for (const s of this.servers) s.syncDocs(docs)
  }

  docChanged(doc: Doc): void {
    for (const s of this.servers) s.docChanged(doc)
  }

  didSave(doc: Doc): void {
    for (const s of this.servers) s.didSave(doc)
  }

  filesChangedOnDisk(paths: string[]): void {
    for (const s of this.servers) s.filesChangedOnDisk(paths.filter((p) => s.handles(p)))
  }

  // ---------- questions about one document ----------

  async completion(doc: Doc, pos: Position, trigger?: string): Promise<{ items: CompletionItem[]; incomplete: boolean }> {
    return this.serverFor(doc)?.completion(doc, pos, trigger) ?? { items: [], incomplete: false }
  }

  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    const s = item.server ? this.server(item.server) : undefined
    return s ? s.resolveCompletion(item) : item
  }

  async hover(doc: Doc, pos: Position): Promise<string | null> {
    return this.serverFor(doc)?.hover(doc, pos) ?? null
  }

  async definition(doc: Doc, pos: Position): Promise<{ path: string; start: Position; end: Position } | null> {
    return this.serverFor(doc)?.definition(doc, pos) ?? null
  }

  async references(doc: Doc, pos: Position): Promise<Location[]> {
    return this.serverFor(doc)?.references(doc, pos) ?? []
  }

  async prepareRename(doc: Doc, pos: Position): Promise<{ start: Position; end: Position; name: string } | null> {
    return this.serverFor(doc)?.prepareRename(doc, pos) ?? null
  }

  async rename(doc: Doc, pos: Position, newName: string): Promise<FileEdits> {
    return this.serverFor(doc)?.rename(doc, pos, newName) ?? new Map()
  }

  async semanticTokens(doc: Doc): Promise<Map<number, SemToken[]> | null> {
    return this.serverFor(doc)?.semanticTokens(doc) ?? null
  }

  async symbols(doc: Doc): Promise<DocSymbol[]> {
    return this.serverFor(doc)?.symbols(doc) ?? []
  }

  async highlights(doc: Doc, pos: Position): Promise<{ start: Position; end: Position; write: boolean }[]> {
    return this.serverFor(doc)?.highlights(doc, pos) ?? []
  }

  async typeDefinition(doc: Doc, pos: Position): Promise<Location[]> {
    return this.serverFor(doc)?.typeDefinition(doc, pos) ?? []
  }

  async prepareCallHierarchy(doc: Doc, pos: Position): Promise<CallItem[]> {
    return this.serverFor(doc)?.prepareCallHierarchy(doc, pos) ?? []
  }

  /** Calls of an item go to the server it came from. */
  async calls(item: CallItem, direction: 'incoming' | 'outgoing'): Promise<{ item: CallItem; at: Position[] }[]> {
    const s = item.server ? this.server(item.server) : undefined
    return s ? s.calls(item, direction) : []
  }

  async codeActions(doc: Doc, start: Position, end: Position, diagnostics: Diagnostic[], only?: string[]): Promise<CodeAction[]> {
    const s = this.serverFor(doc)
    if (!s) return []
    // Only the server's own diagnostics mean anything to it.
    return s.codeActions(doc, start, end, diagnostics.filter((d) => d.server === s.config.id), only)
  }

  /** Run a code action's command on the server it came from. */
  async executeCommand(command: { command: string; arguments?: unknown[] }, server?: string): Promise<void> {
    const s = server ? this.server(server) : this.servers.find((x) => x.isStarted)
    await s?.executeCommand(command)
  }

  // ---------- across the project ----------

  /** Matching symbols from every running server. */
  async workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    const lists = await Promise.all(this.servers.filter((s) => s.isStarted).map((s) => s.workspaceSymbols(query).catch(() => [])))
    return lists.flat()
  }

  // ---------- diagnostics ----------

  onDiagnostics(listener: () => void): void {
    this.listeners.add(listener)
  }

  private changed(): void {
    this.listeners.forEach((l) => l())
  }

  /** Every server's diagnostics for a file, plus other tools' (minus duplicates). */
  diagnosticsFor(path: string): Diagnostic[] {
    const own = this.servers.flatMap((s) => s.diagnosticsFor(path))
    const k = pathKey(path)
    const extra = withoutDuplicates(own, [...this.external.values()].flatMap((m) => m.get(k)?.list ?? []))
    return extra.length ? [...own, ...extra] : own
  }

  /** [path, diagnostics] for every file that has some. */
  allDiagnostics(): [string, Diagnostic[]][] {
    const all = new Map<string, { path: string; list: Diagnostic[] }>()
    const add = (path: string, list: readonly Diagnostic[]) => {
      const k = pathKey(path)
      const cur = all.get(k)
      if (cur) cur.list.push(...list)
      else all.set(k, { path, list: [...list] })
    }
    for (const s of this.servers) for (const [path, list] of s.allDiagnostics()) add(path, list)
    const fromServers = new Map([...all].map(([k, d]) => [k, [...d.list]]))
    for (const m of this.external.values()) {
      for (const [k, d] of m) add(d.path, withoutDuplicates(fromServers.get(k) ?? [], d.list))
    }
    return [...all.values()].map((d) => [d.path, d.list])
  }

  /** Replace another tool's diagnostics for a file (e.g. Ruff). */
  setExternalDiagnostics(source: string, path: string, list: Diagnostic[]): void {
    let bySource = this.external.get(source)
    if (!bySource) this.external.set(source, (bySource = new Map()))
    if (list.length) bySource.set(pathKey(path), { path, list })
    else if (!bySource.delete(pathKey(path))) return
    this.changed()
  }

  /** Forget another tool's diagnostics (all files, or one). */
  clearExternalDiagnostics(source: string, path?: string): void {
    const bySource = this.external.get(source)
    if (!bySource?.size) return
    if (path) bySource.delete(pathKey(path))
    else bySource.clear()
    this.changed()
  }
}

/**
 * Another tool's diagnostics minus those a language server already reports at
 * the same place (e.g. Ruff's F821 "undefined name" next to Pyright's own error).
 */
function withoutDuplicates(own: readonly Diagnostic[], extra: readonly Diagnostic[]): Diagnostic[] {
  if (!own.length) return [...extra]
  const at = new Set(own.filter((d) => d.severity <= 3).map((d) => `${d.start.line}:${d.start.col}`))
  return extra.filter((d) => !at.has(`${d.start.line}:${d.start.col}`))
}
