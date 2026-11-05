/**
 * Python language features via Pyright: keeps the server's view of open
 * files in sync with the editor and collects its diagnostics (errors and
 * warnings). Completion, hover and go-to-definition build on this.
 */
import type { LspClient } from './client'
import type { Doc } from '../editor/document'
import type { Position } from '../editor/textBuffer'
import { pathToUri, uriToPath } from '../../shared/uri'
import type { CompletionItem } from './completionLogic'

export interface Diagnostic {
  start: Position
  end: Position
  /** 1 error, 2 warning, 3 information, 4 hint */
  severity: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
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

const isPython = (path: string) => /\.pyi?$/i.test(path)
/** Windows paths compare case-insensitively and ignore slash direction. */
const key = (path: string) => (/^[a-zA-Z]:/.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path)

export function toPosition(p: { line: number; character: number }): Position {
  return { line: p.line, col: p.character }
}
export function toLsp(p: Position): { line: number; character: number } {
  return { line: p.line, character: p.col }
}

export class PythonLanguage {
  private readonly schedule: Schedule
  private ready: Promise<void> = Promise.resolve()
  private started = false
  private pythonPath: string | undefined
  /** Docs the server knows about, with the version last sent. */
  private readonly open = new Map<Doc, number>()
  private readonly pending = new Set<Doc>()
  private cancelTimer: (() => void) | null = null
  private readonly diagnostics = new Map<string, { path: string; list: Diagnostic[] }>()
  private readonly diagnosticListeners = new Set<() => void>()
  serverCapabilities: Record<string, any> = {}

  constructor(private readonly client: LspClient, opts: { schedule?: Schedule } = {}) {
    this.schedule = opts.schedule ?? defaultSchedule

    client.onRequest('workspace/configuration', (params: { items: { section?: string }[] }) =>
      params.items.map((item) => this.configFor(item.section))
    )
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
        return diag
      })
      if (list.length) this.diagnostics.set(key(path), { path, list })
      else this.diagnostics.delete(key(path))
      this.diagnosticListeners.forEach((l) => l())
    })
  }

  /** Start talking to a (freshly started) server for a project folder. */
  async start(rootPath: string, pythonPath?: string): Promise<void> {
    this.pythonPath = pythonPath
    this.cancelTimer?.()
    this.pending.clear()
    this.diagnostics.clear()
    this.diagnosticListeners.forEach((l) => l())
    const rootUri = pathToUri(rootPath)
    this.ready = (async () => {
      const result = await this.client.request<{ capabilities: Record<string, any> }>('initialize', {
        processId: null,
        clientInfo: { name: 'IDEforfun' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: rootPath.split(/[\\/]/).pop() }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
            completion: {
              completionItem: { snippetSupport: false, documentationFormat: ['plaintext', 'markdown'] },
              contextSupport: true
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: false }
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

  /** Settings Pyright asks for. */
  private configFor(section: string | undefined): unknown {
    if (section === 'python') return this.pythonPath ? { pythonPath: this.pythonPath } : {}
    if (section === 'python.analysis') {
      return { diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, typeCheckingMode: 'standard' }
    }
    return {}
  }

  /** Match the server's open documents to the editor's open tabs. */
  syncDocs(docs: readonly Doc[]): void {
    const wanted = new Set(docs.filter((d) => isPython(d.path)))
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
    this.client.notify('textDocument/didOpen', {
      textDocument: { uri: pathToUri(doc.path), languageId: 'python', version: 1, text: doc.getText() }
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
    return { items: list.map(toCompletionItem), incomplete: !Array.isArray(res) && !!res?.isIncomplete }
  }

  /** Fetch the details/docs for one suggestion (Pyright fills these in lazily). */
  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    if (!this.started || !item.raw || !this.serverCapabilities.completionProvider?.resolveProvider) return item
    const res = await this.client.request<any>('completionItem/resolve', item.raw)
    return { ...item, detail: res?.detail ?? item.detail, documentation: docText(res?.documentation) ?? item.documentation }
  }

  // ---------- diagnostics ----------

  onDiagnostics(listener: () => void): void {
    this.diagnosticListeners.add(listener)
  }

  diagnosticsFor(path: string): Diagnostic[] {
    return this.diagnostics.get(key(path))?.list ?? []
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
  const te = raw.textEdit
  const range = te?.range ?? te?.insert
  if (te && range) item.textEdit = { start: toPosition(range.start), end: toPosition(range.end), text: te.newText }
  return item
}
