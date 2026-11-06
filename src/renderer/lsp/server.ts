/**
 * One language server (Pyright, or any other LSP server): keeps the server's
 * view of open files in sync with the editor, collects its diagnostics and
 * wraps the requests the IDE uses (completion, hover, definitions, rename...).
 * Nothing here is specific to one language: what differs per server is in its
 * ServerConfig (e.g. src/renderer/lsp/pyright.ts). LanguageServices
 * (services.ts) runs several of these side by side.
 */
import type { LspClient } from './client'
import { languageForPath } from '../../shared/languages'
import type { Doc } from '../editor/document'
import type { Position } from '../editor/textBuffer'
import { pathToUri, uriToPath } from '../../shared/uri'
import type { CompletionItem } from './completionLogic'
import {
  parseCallItem, parseCalls, parseHighlights, parseLocations, parseSymbols, parseWorkspaceEdit, parseWorkspaceSymbols,
  type CallItem, type DocSymbol, type FileEdits, type Location, type WorkspaceSymbol
} from './navigation'

export interface Diagnostic {
  start: Position
  end: Position
  /** 1 error, 2 warning, 3 information, 4 hint */
  severity: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
  /** A fix that comes with it (Ruff). */
  fix?: { title: string; edits: { start: Position; end: Position; text: string }[]; safe: boolean }
  /** Link to the rule's documentation. */
  url?: string
  /** Id of the language server that reported it (unset for other tools). */
  server?: string
  /** The server's own diagnostic object (sent back when asking for code actions). */
  raw?: unknown
}

/** A code action from the language server (quick fix, organise imports...). */
export interface CodeAction {
  title: string
  kind: string
  preferred: boolean
  edit?: FileEdits
  command?: { command: string; arguments?: unknown[] }
  /** Id of the server it came from (to run its command there). */
  server?: string
}

/** What differs between language servers. */
export interface ServerConfig {
  /** Id in the main process's server registry, and `server` in src/shared/languages.ts. */
  id: string
  /** Shown in messages ("Pyright"). */
  name: string
  /** Language ids it handles (default: the languages whose `server` is this id). */
  languages?: readonly string[]
  /** Answer the server's workspace/configuration request for one section. `settings` come from start(). */
  configuration?(section: string | undefined, settings: Readonly<Record<string, unknown>>): unknown
}

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

/** Debounce for sending edits to the server. */
const CHANGE_DELAY_MS = 150

type Schedule = (fn: () => void, ms: number) => () => void
const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/** Windows paths compare case-insensitively and ignore slash direction. */
export const pathKey = (path: string): string => (/^[a-zA-Z]:/.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path)

export function toPosition(p: { line: number; character: number }): Position {
  return { line: p.line, col: p.character }
}
export function toLsp(p: Position): { line: number; character: number } {
  return { line: p.line, character: p.col }
}

export class LspServer {
  private readonly schedule: Schedule
  private ready: Promise<void> = Promise.resolve()
  private started = false
  private settings: Readonly<Record<string, unknown>> = {}
  /** Docs the server knows about, with the version last sent. */
  private readonly open = new Map<Doc, number>()
  private readonly pending = new Set<Doc>()
  private cancelTimer: (() => void) | null = null
  private readonly diagnostics = new Map<string, { path: string; list: Diagnostic[] }>()
  private readonly diagnosticListeners = new Set<() => void>()
  /** Applies edits the server asks for (workspace/applyEdit); returns whether it worked. */
  applyEditHandler: ((edits: FileEdits) => Promise<boolean> | boolean) | null = null
  serverCapabilities: Record<string, any> = {}

  constructor(private readonly client: LspClient, readonly config: ServerConfig, opts: { schedule?: Schedule } = {}) {
    this.schedule = opts.schedule ?? defaultSchedule

    client.onRequest('workspace/configuration', (params: { items: { section?: string }[] }) =>
      params.items.map((item) => this.configFor(item.section))
    )
    client.onRequest('workspace/applyEdit', async (params: { edit: unknown }) => {
      const edits = parseWorkspaceEdit(params?.edit)
      const applied = this.applyEditHandler ? await this.applyEditHandler(edits) : false
      return { applied }
    })
    client.onNotification('textDocument/publishDiagnostics', (params: { uri: string; diagnostics: any[] }) => {
      const path = uriToPath(params.uri)
      const list: Diagnostic[] = params.diagnostics.map((d) => {
        const diag: Diagnostic = {
          start: toPosition(d.range.start),
          end: toPosition(d.range.end),
          severity: d.severity ?? 1,
          message: d.message
        }
        if (d.source !== undefined) diag.source = d.source
        if (d.code !== undefined) diag.code = d.code
        diag.server = this.config.id
        diag.raw = d
        return diag
      })
      if (list.length) this.diagnostics.set(pathKey(path), { path, list })
      else this.diagnostics.delete(pathKey(path))
      this.diagnosticListeners.forEach((l) => l())
    })
  }

  /** Start talking to a (freshly started) server for a project folder. */
  async start(rootPath: string, settings: Readonly<Record<string, unknown>> = {}): Promise<void> {
    this.settings = settings
    this.cancelTimer?.()
    this.pending.clear()
    this.diagnostics.clear()
    this.diagnosticListeners.forEach((l) => l())
    const rootUri = pathToUri(rootPath)
    this.ready = (async () => {
      const result = await this.client.request<{ capabilities: Record<string, any> }>('initialize', {
        processId: null,
        clientInfo: { name: 'Forge' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: rootPath.split(/[\\/]/).pop() }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true }, applyEdit: true, executeCommand: {} },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
            completion: {
              completionItem: { snippetSupport: false, documentationFormat: ['plaintext', 'markdown'] },
              contextSupport: true
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: false },
            references: {},
            rename: { prepareSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            typeDefinition: { linkSupport: false },
            documentHighlight: {},
            callHierarchy: {},
            codeAction: {
              codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports'] } },
              isPreferredSupport: true
            }
          }
        }
      })
      this.serverCapabilities = result?.capabilities ?? {}
      this.client.notify('initialized', {})
      this.client.notify('workspace/didChangeConfiguration', { settings: {} })
      this.started = true
    })()
    await this.ready
    // Re-open everything we were tracking (after a restart).
    for (const [doc] of this.open) this.sendOpen(doc)
  }

  /** Settings the server asks for. */
  private configFor(section: string | undefined): unknown {
    return this.config.configuration?.(section, this.settings) ?? {}
  }

  /** Is this file in a language this server handles? */
  handles(path: string): boolean {
    const lang = languageForPath(path)
    return this.config.languages ? this.config.languages.includes(lang.id) : lang.server === this.config.id
  }

  /** Match the server's open documents to the editor's open tabs (those in its languages). */
  syncDocs(docs: readonly Doc[]): void {
    const wanted = new Set(docs.filter((d) => this.handles(d.path)))
    for (const doc of [...this.open.keys()]) {
      if (wanted.has(doc)) continue
      this.open.delete(doc)
      this.pending.delete(doc)
      if (this.started) this.client.notify('textDocument/didClose', { textDocument: { uri: pathToUri(doc.path) } })
    }
    for (const doc of wanted) {
      if (this.open.has(doc)) continue
      this.open.set(doc, 1)
      if (this.started) this.sendOpen(doc)
    }
  }

  private sendOpen(doc: Doc): void {
    this.open.set(doc, 1)
    const lang = languageForPath(doc.path)
    this.client.notify('textDocument/didOpen', {
      textDocument: { uri: pathToUri(doc.path), languageId: lang.lspId ?? lang.id, version: 1, text: doc.getText() }
    })
  }

  /** The editor changed this doc; send it to the server shortly. */
  docChanged(doc: Doc): void {
    if (!this.open.has(doc)) return
    this.pending.add(doc)
    this.cancelTimer?.()
    this.cancelTimer = this.schedule(() => this.flush(), CHANGE_DELAY_MS)
  }

  /** Send any pending edits now (call before asking the server about a doc). */
  flush(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    if (!this.started) return
    for (const doc of this.pending) {
      const version = (this.open.get(doc) ?? 1) + 1
      this.open.set(doc, version)
      this.client.notify('textDocument/didChange', {
        textDocument: { uri: pathToUri(doc.path), version },
        contentChanges: [{ text: doc.getText() }]
      })
    }
    this.pending.clear()
  }

  didSave(doc: Doc): void {
    if (!this.open.has(doc) || !this.started) return
    this.flush()
    this.client.notify('textDocument/didSave', { textDocument: { uri: pathToUri(doc.path) } })
  }

  // ---------- completion ----------

  /** Ask for suggestions at `pos`. `trigger` is the character that triggered it (e.g. '.'). */
  async completion(doc: Doc, pos: Position, trigger?: string): Promise<{ items: CompletionItem[]; incomplete: boolean }> {
    if (!this.started || !this.open.has(doc)) return { items: [], incomplete: false }
    this.flush()
    const res = await this.client.request<any>('textDocument/completion', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos),
      context: trigger ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: 1 }
    })
    const list: any[] = Array.isArray(res) ? res : res?.items ?? []
    return { items: list.map((raw) => ({ ...toCompletionItem(raw), server: this.config.id })), incomplete: !Array.isArray(res) && !!res?.isIncomplete }
  }

  /** Fetch the details/docs for one suggestion (Pyright fills these in lazily). */
  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    if (!this.started || !item.raw || !this.serverCapabilities.completionProvider?.resolveProvider) return item
    const res = await this.client.request<any>('completionItem/resolve', item.raw)
    return { ...item, detail: res?.detail ?? item.detail, documentation: docText(res?.documentation) ?? item.documentation }
  }

  // ---------- hover & go to definition ----------

  /** Type/signature/docs for the symbol at `pos`, as Markdown (or null). */
  async hover(doc: Doc, pos: Position): Promise<string | null> {
    if (!this.started || !this.open.has(doc)) return null
    this.flush()
    const res = await this.client.request<any>('textDocument/hover', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos)
    })
    const c = res?.contents
    if (!c) return null
    const parts = Array.isArray(c) ? c : [c]
    const text = parts
      .map((p: any) => (typeof p === 'string' ? p : p.language ? '```' + p.language + '\n' + p.value + '\n```' : p.value))
      .join('\n\n')
      .trim()
    return text || null
  }

  /** Where the symbol at `pos` is defined (first result), or null. */
  async definition(doc: Doc, pos: Position): Promise<{ path: string; start: Position; end: Position } | null> {
    if (!this.started || !this.open.has(doc)) return null
    this.flush()
    const res = await this.client.request<any>('textDocument/definition', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos)
    })
    const first = Array.isArray(res) ? res[0] : res
    if (!first) return null
    // Location { uri, range } or LocationLink { targetUri, targetSelectionRange }
    const uri: string = first.uri ?? first.targetUri
    const range = first.range ?? first.targetSelectionRange ?? first.targetRange
    if (!uri || !range) return null
    return { path: uriToPath(uri), start: toPosition(range.start), end: toPosition(range.end) }
  }

  // ---------- references, rename, symbols ----------

  /** Every use of the symbol at `pos` across the project (including its definition). */
  async references(doc: Doc, pos: Position): Promise<Location[]> {
    if (!this.started || !this.open.has(doc)) return []
    this.flush()
    const res = await this.client.request<unknown>('textDocument/references', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos),
      context: { includeDeclaration: true }
    })
    return parseLocations(res)
  }

  /**
   * Can the thing at `pos` be renamed? Returns its range and current name,
   * or null (e.g. a keyword, or something from a library).
   */
  async prepareRename(doc: Doc, pos: Position): Promise<{ start: Position; end: Position; name: string } | null> {
    if (!this.started || !this.open.has(doc)) return null
    this.flush()
    const res = await this.client.request<any>('textDocument/prepareRename', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos)
    })
    const range = res?.range ?? (res?.start ? res : null)
    if (!range?.start) return null
    const start = toPosition(range.start)
    const end = toPosition(range.end)
    const name = typeof res.placeholder === 'string' ? res.placeholder : start.line === end.line ? doc.buffer.getLine(start.line).slice(start.col, end.col) : ''
    return { start, end, name }
  }

  /** The edits that rename the symbol at `pos` to `newName`, per file. */
  async rename(doc: Doc, pos: Position, newName: string): Promise<FileEdits> {
    if (!this.started || !this.open.has(doc)) return new Map()
    this.flush()
    const res = await this.client.request<unknown>('textDocument/rename', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos),
      newName
    })
    return parseWorkspaceEdit(res)
  }

  /** The classes, functions, methods and variables in a file (for the outline). */
  async symbols(doc: Doc): Promise<DocSymbol[]> {
    if (!this.started || !this.open.has(doc)) return []
    this.flush()
    const res = await this.client.request<unknown>('textDocument/documentSymbol', { textDocument: { uri: pathToUri(doc.path) } })
    return parseSymbols(res)
  }

  /** Other uses of the name at `pos` in the same file (to highlight them). */
  async highlights(doc: Doc, pos: Position): Promise<{ start: Position; end: Position; write: boolean }[]> {
    if (!this.started || !this.open.has(doc)) return []
    this.flush()
    const res = await this.client.request<unknown>('textDocument/documentHighlight', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos)
    })
    return parseHighlights(res)
  }

  /** Where the type of the thing at `pos` is defined (e.g. the class of a variable). */
  async typeDefinition(doc: Doc, pos: Position): Promise<Location[]> {
    if (!this.started || !this.open.has(doc)) return []
    this.flush()
    const res = await this.client.request<unknown>('textDocument/typeDefinition', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos)
    })
    return parseLocations(res)
  }

  /** Classes, functions and variables across the project whose name matches `query`. */
  async workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    if (!this.started) return []
    this.flush()
    return parseWorkspaceSymbols(await this.client.request<unknown>('workspace/symbol', { query }))
  }

  /** The function/method at `pos`, as the start of a call hierarchy. */
  async prepareCallHierarchy(doc: Doc, pos: Position): Promise<CallItem[]> {
    if (!this.started || !this.open.has(doc)) return []
    this.flush()
    const res = await this.client.request<unknown[]>('textDocument/prepareCallHierarchy', {
      textDocument: { uri: pathToUri(doc.path) },
      position: toLsp(pos)
    })
    return (Array.isArray(res) ? res : []).map(parseCallItem).filter((i): i is CallItem => !!i).map((i) => ({ ...i, server: this.config.id }))
  }

  /** Who calls `item` (incoming) or what `item` calls (outgoing). */
  async calls(item: CallItem, direction: 'incoming' | 'outgoing'): Promise<{ item: CallItem; at: Position[] }[]> {
    if (!this.started) return []
    const res = await this.client.request<unknown>(`callHierarchy/${direction}Calls`, { item: item.raw })
    return parseCalls(res, direction === 'incoming' ? 'from' : 'to').map((c) => ({ ...c, item: { ...c.item, server: this.config.id } }))
  }

  /** Quick fixes and other actions for a range (with the diagnostics there). */
  async codeActions(doc: Doc, start: Position, end: Position, diagnostics: Diagnostic[], only?: string[]): Promise<CodeAction[]> {
    if (!this.started || !this.open.has(doc)) return []
    this.flush()
    const res = await this.client.request<any[]>('textDocument/codeAction', {
      textDocument: { uri: pathToUri(doc.path) },
      range: { start: toLsp(start), end: toLsp(end) },
      context: { diagnostics: diagnostics.map((d) => d.raw).filter(Boolean), ...(only ? { only } : {}) }
    })
    const out: CodeAction[] = []
    for (const a of Array.isArray(res) ? res : []) {
      if (!a || typeof a.title !== 'string') continue
      // A bare Command (no kind/edit) is also allowed.
      if (typeof a.command === 'string') {
        out.push({ title: a.title, kind: '', preferred: false, command: { command: a.command, arguments: a.arguments }, server: this.config.id })
        continue
      }
      const action: CodeAction = { title: a.title, kind: typeof a.kind === 'string' ? a.kind : '', preferred: !!a.isPreferred, server: this.config.id }
      if (a.edit) action.edit = parseWorkspaceEdit(a.edit)
      if (a.command?.command) action.command = { command: a.command.command, arguments: a.command.arguments }
      if (action.edit || action.command) out.push(action)
    }
    return out
  }

  /** Run a server command (e.g. from a code action). Edits come back via workspace/applyEdit. */
  async executeCommand(command: { command: string; arguments?: unknown[] }): Promise<void> {
    if (!this.started) return
    await this.client.request('workspace/executeCommand', { command: command.command, arguments: command.arguments ?? [] })
  }

  /** Tell the server files changed on disk behind its back (e.g. a rename edited closed files). */
  filesChangedOnDisk(paths: string[]): void {
    if (!this.started || !paths.length) return
    this.client.notify('workspace/didChangeWatchedFiles', { changes: paths.map((p) => ({ uri: pathToUri(p), type: 2 })) })
  }

  /** Is this doc known to the server (open, and in one of its languages)? */
  knows(doc: Doc): boolean {
    return this.started && this.open.has(doc)
  }

  // ---------- diagnostics ----------

  onDiagnostics(listener: () => void): void {
    this.diagnosticListeners.add(listener)
  }

  diagnosticsFor(path: string): Diagnostic[] {
    return this.diagnostics.get(pathKey(path))?.list ?? []
  }

  /** [path, diagnostics] for every file that has some. */
  allDiagnostics(): [string, Diagnostic[]][] {
    return [...this.diagnostics.values()].map((d) => [d.path, d.list])
  }

  /** Wait until the server is initialized (for requests made right after start). */
  whenReady(): Promise<void> {
    return this.ready
  }

  get isStarted(): boolean {
    return this.started
  }

  /** The server went away: requests are rejected by the client; forget we were started. */
  stopped(): void {
    this.started = false
  }

  protected get lspClient(): LspClient {
    return this.client
  }
}

/** LSP documentation is a string or { kind, value }. */
export function docText(doc: unknown): string | undefined {
  if (typeof doc === 'string') return doc
  if (doc && typeof doc === 'object' && 'value' in doc) return String((doc as { value: unknown }).value)
  return undefined
}

function toCompletionItem(raw: any): CompletionItem {
  const item: CompletionItem = { label: raw.label, kind: raw.kind, raw }
  if (raw.detail) item.detail = raw.detail
  const doc = docText(raw.documentation)
  if (doc) item.documentation = doc
  if (raw.insertText) item.insertText = raw.insertText
  if (raw.filterText) item.filterText = raw.filterText
  if (raw.sortText) item.sortText = raw.sortText
  // Pyright marks auto-imports in detail ("Auto-import") and/or data.autoImportText.
  if (raw.data?.autoImportText || /auto-import/i.test(raw.detail ?? '') || /auto-import/i.test(raw.labelDetails?.description ?? '')) item.autoImport = true
  const te = raw.textEdit
  const range = te?.range ?? te?.insert
  if (te && range) item.textEdit = { start: toPosition(range.start), end: toPosition(range.end), text: te.newText }
  return item
}
