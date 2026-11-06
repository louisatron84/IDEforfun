/**
 * Code quality tools for Python files:
 *  - Ruff warnings as you type (shown with Pyright's errors), with a 💡 on
 *    lines that have an automatic fix
 *  - Quick Fix (Ctrl+.): Ruff's fixes, Pyright's code actions, "ignore this
 *    rule on this line", organise imports, format
 *  - Format Document / Selection with Ruff or Black, and format on save
 *  - Organise Imports (Ruff's isort rules + unused imports, or Pyright's)
 * The tools run on the editor's text (unsaved changes count).
 */
import type { Doc } from './editor/document'
import type { Position } from './editor/textBuffer'
import type { CodeAction, Diagnostic } from './lsp/server'
import type { LanguageServices } from './lsp/services'
import type { FileEdits, TextEdit } from './lsp/navigation'
import type { Palette } from './palette'
import type { Settings } from '../shared/settings'
import { lineDiff, parseRuffJson } from '../shared/lint'

export interface CodeToolsHooks {
  languages: LanguageServices
  palette: Palette
  root(): string | null
  /** The project's interpreter (to find Ruff / Black in it), if known. */
  interpreter(): string | null
  settings(): Settings
  active(): Doc | null
  /** The selection in the active editor (start <= end). */
  selection(): { start: Position; end: Position }
  /** Apply edits to an open document as one undoable step. */
  applyEdits(doc: Doc, edits: TextEdit[]): void
  /** Apply edits that may touch several files. */
  applyFileEdits(edits: FileEdits): Promise<boolean>
  /** pip install a tool into the project's interpreter. */
  install(tool: 'ruff' | 'black'): void
  setLightbulb(line: number | null): void
  /** A short message (e.g. "Already formatted"). */
  note(message: string): void
  report(message: string): void
}

const isPython = (doc: Doc) => /\.pyi?$/i.test(doc.path)
const LINT_DELAY_MS = 700

export class CodeTools {
  /** Version of each doc last linted (to skip unchanged ones). */
  private linted = new WeakMap<Doc, number>()
  private timers = new Map<Doc, number>()
  /** Paths with Ruff diagnostics shown (to clear them when closed). */
  private shown = new Set<string>()
  /** Ruff wasn't found (don't keep trying on every keystroke). */
  private ruffMissing = false

  constructor(private readonly hooks: CodeToolsHooks) {}

  private get cwd(): string | null {
    return this.hooks.root()
  }

  private textOf(doc: Doc): string {
    return doc.buffer.getLines().join('\n')
  }

  // ---------- linting ----------

  /** Re-lint open Python docs that changed (call after edits, opening files, settings changes). */
  sync(docs: readonly Doc[]): void {
    const on = this.hooks.settings().lintWithRuff
    const open = new Set(docs.map((d) => d.path))
    // Closed files, or linting turned off: remove their warnings.
    for (const path of [...this.shown]) {
      if (!on || !open.has(path)) {
        this.hooks.languages.clearExternalDiagnostics('ruff', path)
        this.shown.delete(path)
      }
    }
    if (!on || this.ruffMissing) return
    for (const doc of docs) {
      if (!isPython(doc) || doc.large) continue
      if (this.linted.get(doc) === doc.version) continue
      this.lintSoon(doc)
    }
  }

  /** Ruff may have been installed (or the interpreter changed): try again. */
  retry(docs: readonly Doc[]): void {
    this.ruffMissing = false
    this.linted = new WeakMap()
    this.sync(docs)
  }

  private lintSoon(doc: Doc, delay = LINT_DELAY_MS): void {
    window.clearTimeout(this.timers.get(doc))
    this.timers.set(doc, window.setTimeout(() => {
      this.timers.delete(doc)
      void this.lint(doc)
    }, delay))
  }

  private async lint(doc: Doc): Promise<void> {
    const cwd = this.cwd ?? doc.path.replace(/[\\/][^\\/]*$/, '')
    const version = doc.version
    const res = await window.api.ruffCheck(this.hooks.interpreter(), cwd, doc.path, this.textOf(doc)).catch(() => null)
    if (!res) return
    if (res.missing) {
      this.ruffMissing = true
      return
    }
    if (doc.version !== version) return // changed meanwhile: a newer lint is coming
    this.linted.set(doc, version)
    if (!res.ok) return // e.g. a broken ruff config: Pyright still shows errors
    const list: Diagnostic[] = parseRuffJson(res.output)
      .filter((p) => p.code !== 'syntax') // Pyright reports syntax errors already
      .map((p) => {
        const d: Diagnostic = { start: p.start, end: p.end, severity: 2, message: p.message, source: 'Ruff', code: p.code }
        if (p.fix) d.fix = p.fix
        if (p.url) d.url = p.url
        return d
      })
    if (!this.hooks.settings().lintWithRuff) return
    this.hooks.languages.setExternalDiagnostics('ruff', doc.path, list)
    if (list.length) this.shown.add(doc.path)
    else this.shown.delete(doc.path)
  }

  /** Show the 💡 when the cursor's line has a Ruff fix. */
  updateLightbulb(doc: Doc | null, line: number | null): void {
    if (!doc || line === null) return this.hooks.setLightbulb(null)
    const has = this.hooks.languages.diagnosticsFor(doc.path).some((d) => d.fix && d.start.line <= line && line <= d.end.line)
    this.hooks.setLightbulb(has ? line : null)
  }

  // ---------- quick fixes ----------

  /** Ctrl+. : what can be done here. */
  async quickFix(): Promise<void> {
    const doc = this.hooks.active()
    if (!doc) return
    const { palette, languages } = this.hooks
    const sel = this.hooks.selection()
    const line = sel.start.line
    const here = languages.diagnosticsFor(doc.path).filter((d) => d.start.line <= sel.end.line && line <= d.end.line)
    type Item = { label: string; detail?: string; hint?: string; run: () => void }
    const items: Item[] = []

    // Ruff's own fixes for problems on this line.
    for (const d of here) {
      if (!d.fix) continue
      const fix = d.fix
      items.push({
        label: fix.title,
        detail: `${d.code}: ${d.message}`,
        hint: fix.safe ? 'Ruff' : 'Ruff (review it)',
        run: () => {
          this.hooks.applyEdits(doc, fix.edits)
          this.lintSoon(doc, 100)
        }
      })
    }
    // The language server's actions (quick fixes, refactorings).
    let actions: CodeAction[] = []
    if (languages.knows(doc)) {
      actions = await languages.codeActions(doc, sel.start, sel.end, here.filter((d) => d.source !== 'Ruff')).catch(() => [])
    }
    for (const a of actions.sort((x, y) => Number(y.preferred) - Number(x.preferred))) {
      if (a.kind.startsWith('source.organizeImports')) continue // offered below
      items.push({ label: a.title, hint: (a.server && languages.server(a.server)?.config.name) || '', run: () => void this.runAction(a) })
    }
    // Ignore a Ruff rule on this line.
    const ruffCodes = [...new Set(here.filter((d) => d.source === 'Ruff' && d.code).map((d) => String(d.code)))]
    for (const code of ruffCodes) {
      items.push({ label: `Ignore ${code} on this line`, detail: `adds  # noqa: ${code}`, run: () => this.addNoqa(doc, here.find((d) => d.code === code)!.start.line, code) })
    }
    if (languages.diagnosticsFor(doc.path).some((d) => d.fix?.safe)) {
      items.push({ label: 'Fix all auto-fixable problems in this file', detail: 'ruff check --fix', run: () => void this.fixAll() })
    }
    items.push(
      { label: 'Organize Imports', hint: 'Shift+Alt+O', run: () => void this.organizeImports() },
      { label: 'Format Document', hint: 'Shift+Alt+F', run: () => void this.format() }
    )
    if (this.ruffMissing) {
      items.push({ label: 'Install Ruff for more warnings and fixes', detail: 'pip install ruff', run: () => this.hooks.install('ruff') })
    }
    const problems = here.length ? `${here.length} problem${here.length > 1 ? 's' : ''} here` : 'no problems here'
    palette.choose(`Quick fixes (${problems})`, items)
  }

  private async runAction(a: CodeAction): Promise<void> {
    try {
      if (a.edit?.size) await this.hooks.applyFileEdits(a.edit)
      if (a.command) await this.hooks.languages.executeCommand(a.command, a.server)
    } catch (err) {
      this.hooks.report(`"${a.title}" failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Append `# noqa: CODE` to a line (or add the code to an existing noqa comment). */
  private addNoqa(doc: Doc, line: number, code: string): void {
    const text = doc.buffer.getLine(line)
    const m = /#\s*noqa(?::\s*([\w,\s]+))?\s*$/i.exec(text)
    let edit: TextEdit
    if (m && m[1] !== undefined) {
      const codes = m[1].split(/[,\s]+/).filter(Boolean)
      if (codes.includes(code)) return
      edit = { start: { line, col: m.index }, end: { line, col: text.length }, text: `# noqa: ${[...codes, code].join(', ')}` }
    } else if (m) {
      return // a bare "# noqa" already ignores everything
    } else {
      edit = { start: { line, col: text.length }, end: { line, col: text.length }, text: `  # noqa: ${code}` }
    }
    this.hooks.applyEdits(doc, [edit])
    this.lintSoon(doc, 100)
  }

  // ---------- whole-file tools ----------

  /** Replace the doc's text with a tool's output, changing only the lines that differ. */
  private replaceText(doc: Doc, before: string, after: string): boolean {
    const edit = lineDiff(before, after)
    if (!edit) return false
    this.hooks.applyEdits(doc, [edit])
    return true
  }

  /** Which formatter to use, or null (after offering to install one). */
  private async formatter(quiet: boolean): Promise<'ruff' | 'black' | null> {
    const pref = this.hooks.settings().formatter
    const cwd = this.cwd ?? '.'
    const have = await window.api.toolsAvailable(this.hooks.interpreter(), cwd).catch(() => ({ ruff: false, black: false }))
    if (pref === 'ruff' ? have.ruff : pref === 'black' ? have.black : have.ruff || have.black) {
      return pref === 'auto' ? (have.ruff ? 'ruff' : 'black') : pref
    }
    if (!quiet) {
      const want = pref === 'black' ? 'black' : 'ruff'
      this.hooks.palette.choose(`${want === 'ruff' ? 'Ruff' : 'Black'} isn't installed in this project's Python`, [
        { label: `Install ${want === 'ruff' ? 'Ruff' : 'Black'}`, detail: `pip install ${want}`, run: () => this.hooks.install(want) },
        ...(pref === 'auto' ? [{ label: 'Install Black instead', detail: 'pip install black', run: () => this.hooks.install('black') }] : []),
        { label: 'Cancel', run: () => {} }
      ])
    }
    return null
  }

  /**
   * Format the active Python file (or just the selected lines). `quiet` is for
   * format-on-save: problems don't interrupt saving.
   */
  async format(opts: { selection?: boolean; doc?: Doc; quiet?: boolean } = {}): Promise<void> {
    const doc = opts.doc ?? this.hooks.active()
    if (!doc) return
    if (!isPython(doc)) {
      if (!opts.quiet) this.hooks.note('Formatting is for Python files.')
      return
    }
    const tool = await this.formatter(!!opts.quiet)
    if (!tool) return
    let lines: { from: number; to: number } | undefined
    if (opts.selection) {
      const sel = this.hooks.selection()
      if (sel.start.line !== sel.end.line || sel.start.col !== sel.end.col) {
        const endLine = sel.end.col === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line
        lines = { from: sel.start.line + 1, to: endLine + 1 }
      }
    }
    const before = this.textOf(doc)
    const version = doc.version
    const res = await window.api.formatText(this.hooks.interpreter(), this.cwd ?? '.', doc.path, before, tool, lines).catch((err) => ({ ok: false, output: '', error: String(err) }))
    if (!res.ok) {
      if (!opts.quiet) this.hooks.report(res.error ?? 'Formatting failed.')
      else this.hooks.note(`Not formatted: ${(res.error ?? '').split('\n')[0]}`)
      return
    }
    if (doc.version !== version) return // edited while formatting: don't overwrite
    if (!this.replaceText(doc, before, res.output) && !opts.quiet) this.hooks.note('Already formatted.')
  }

  /** Sort imports and remove unused ones (Ruff), or Pyright's organise imports. */
  async organizeImports(): Promise<void> {
    const doc = this.hooks.active()
    if (!doc || !isPython(doc)) return
    const before = this.textOf(doc)
    const version = doc.version
    const res = await window.api.ruffFix(this.hooks.interpreter(), this.cwd ?? '.', doc.path, before, ['I', 'F401']).catch(() => null)
    if (res?.ok) {
      if (doc.version !== version) return
      if (!this.replaceText(doc, before, res.output)) this.hooks.note('Imports are already organized.')
      return
    }
    // No Ruff: Pyright can sort imports (but not remove unused ones).
    if (this.hooks.languages.knows(doc)) {
      const end = doc.buffer.clamp({ line: Infinity, col: Infinity })
      const actions = await this.hooks.languages.codeActions(doc, { line: 0, col: 0 }, end, [], ['source.organizeImports']).catch(() => [])
      if (actions.length) {
        await this.runAction(actions[0])
        return
      }
    }
    if (res?.missing) {
      this.hooks.palette.choose("Organize Imports uses Ruff, which isn't installed in this project's Python", [
        { label: 'Install Ruff', detail: 'pip install ruff', run: () => this.hooks.install('ruff') },
        { label: 'Cancel', run: () => {} }
      ])
    } else if (res?.error) this.hooks.report(res.error)
  }

  /** Apply every safe Ruff fix in the file. */
  async fixAll(): Promise<void> {
    const doc = this.hooks.active()
    if (!doc || !isPython(doc)) return
    const before = this.textOf(doc)
    const version = doc.version
    const res = await window.api.ruffFix(this.hooks.interpreter(), this.cwd ?? '.', doc.path, before).catch(() => null)
    if (!res?.ok) {
      if (res?.missing) this.hooks.install('ruff')
      else this.hooks.report(res?.error ?? 'Ruff failed.')
      return
    }
    if (doc.version !== version) return
    if (!this.replaceText(doc, before, res.output)) this.hooks.note('Nothing to fix automatically.')
    this.lintSoon(doc, 100)
  }
}
