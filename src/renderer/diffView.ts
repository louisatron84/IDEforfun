/**
 * The diff viewer: what changed in one file, shown over the editor. Old and
 * new line numbers, removed lines red, added lines green, Python colored.
 * Each hunk can be staged, unstaged or discarded on its own.
 */
import { hunkPatch, parseDiff, type FileChange, type FileDiff, type Hunk } from '../shared/git'
import { tokenizeLine } from './editor/tokenizer'
import type { Repo } from './gitView'

export interface DiffHooks {
  openFile(absPath: string, line: number): void
  /** Run a git action (shows errors, refreshes the Git view); returns whether it worked. */
  run(action: () => Promise<{ ok: boolean; error?: string; output: string }>, busyText: string): Promise<boolean>
  closed(): void
}

interface Shown {
  repo: Repo
  change: FileChange
  staged: boolean
}

export class DiffView {
  readonly el: HTMLDivElement
  private shown: Shown | null = null
  private generation = 0

  constructor(private readonly hooks: DiffHooks) {
    this.el = document.createElement('div')
    this.el.className = 'diff-view'
    this.el.hidden = true
    this.el.tabIndex = -1
    this.el.setAttribute('role', 'region')
    this.el.setAttribute('aria-label', 'Changes')
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.hide()
      }
    })
  }

  get isVisible(): boolean {
    return !this.el.hidden
  }

  get current(): Shown | null {
    return this.isVisible ? this.shown : null
  }

  hide(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.shown = null
    this.hooks.closed()
  }

  private abs(repo: Repo, path: string): string {
    const sep = repo.root.includes('\\') ? '\\' : '/'
    return repo.root.replace(/[\\/]+$/, '') + sep + path.split('/').join(sep)
  }

  async show(repo: Repo, change: FileChange, staged: boolean): Promise<void> {
    this.shown = { repo, change, staged }
    this.el.hidden = false
    this.el.focus({ preventScroll: true })
    await this.reload()
  }

  /** Load the diff again (after staging a hunk, or the file changed). */
  async reload(): Promise<void> {
    const shown = this.shown
    if (!shown) return
    const gen = ++this.generation
    const { repo, change, staged } = shown
    let diff: FileDiff | null = null
    let note = ''
    if (change.kind === 'untracked') {
      // Not in git yet: the whole file is new.
      const res = await window.api.readTextFile(this.abs(repo, change.path)).catch(() => null)
      if (res?.kind === 'text') {
        const lines = res.text.split(/\r\n|\r|\n/)
        if (lines[lines.length - 1] === '') lines.pop()
        diff = {
          head: [], oldPath: null, newPath: change.path, binary: false,
          hunks: [{ header: '', oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((text, i) => ({ type: '+', text, oldNo: null, newNo: i + 1 })) }]
        }
      } else note = res ? 'This is a binary or very large file, so there is no text to compare.' : "Couldn't read the file."
    } else {
      const res = await window.api.gitDiff(repo.root, change.path, staged)
      if (!res.ok) note = res.error ?? "Couldn't get the diff."
      else diff = parseDiff(res.output)[0] ?? null
      if (res.ok && !diff) note = staged ? 'Nothing staged in this file any more.' : 'No unstaged changes left in this file.'
      else if (diff?.binary) note = 'Binary file changed (no text to compare).'
    }
    if (gen !== this.generation) return
    this.render(shown, diff, note)
  }

  private render(shown: Shown, diff: FileDiff | null, note: string): void {
    const { repo, change, staged } = shown
    const untracked = change.kind === 'untracked'
    const head = document.createElement('div')
    head.className = 'diff-head'
    const title = document.createElement('div')
    title.className = 'diff-title'
    const name = document.createElement('strong')
    name.textContent = change.path
    const what = document.createElement('span')
    what.className = 'diff-what'
    what.textContent = untracked ? 'New file (not in git yet)' : staged ? 'Staged changes (compared with the last commit)' : 'Changes not staged yet'
    title.append(name, what)
    const buttons = document.createElement('div')
    buttons.className = 'diff-buttons'
    const add = (text: string, tip: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = text
      b.title = tip
      b.addEventListener('click', fn)
      buttons.append(b)
    }
    if (change.kind !== 'deleted') add('Open File', 'Open the file in the editor', () => this.hooks.openFile(this.abs(repo, change.path), diff?.hunks[0]?.newStart ? diff.hunks[0].newStart - 1 : 0))
    if (staged) add('Unstage File', 'Take all of this file out of the next commit', () => void this.act(() => window.api.gitUnstage(repo.root, [change.path]), 'Unstaging…'))
    else add('Stage File', 'Put all of this file in the next commit', () => void this.act(() => window.api.gitStage(repo.root, [change.path]), 'Staging…'))
    add('×', 'Close (Escape)', () => this.hide())
    head.append(title, buttons)

    const body = document.createElement('div')
    body.className = 'diff-body'
    if (note || !diff) {
      const n = document.createElement('div')
      n.className = 'problems-empty'
      n.textContent = note || 'Nothing to show.'
      body.append(n)
    } else {
      const python = /\.pyi?$/i.test(change.path)
      for (const hunk of diff.hunks) body.append(this.renderHunk(shown, diff, hunk, python))
    }
    this.el.replaceChildren(head, body)
  }

  private renderHunk(shown: Shown, file: FileDiff, hunk: Hunk, python: boolean): HTMLElement {
    const { repo, change, staged } = shown
    const box = document.createElement('div')
    box.className = 'diff-hunk'
    if (hunk.header) {
      const h = document.createElement('div')
      h.className = 'diff-hunk-head'
      const label = document.createElement('span')
      const added = hunk.lines.filter((l) => l.type === '+').length
      const removed = hunk.lines.filter((l) => l.type === '-').length
      label.textContent = `Lines ${hunk.newStart}–${hunk.newStart + Math.max(0, hunk.newLines - 1)}  (+${added} −${removed})${hunk.header.replace(/^@@[^@]*@@/, '') ? '  ·' + hunk.header.replace(/^@@[^@]*@@/, '') : ''}`
      h.append(label)
      const btn = (text: string, tip: string, fn: () => void) => {
        const b = document.createElement('button')
        b.textContent = text
        b.title = tip
        b.addEventListener('click', fn)
        h.append(b)
      }
      const patch = () => hunkPatch(file, hunk)
      if (staged) btn('Unstage Hunk', 'Take just these lines out of the next commit', () => void this.act(() => window.api.gitApply(repo.root, patch(), { cached: true, reverse: true }), 'Unstaging…'))
      else if (change.kind !== 'untracked') {
        btn('Discard Hunk', 'Throw away just these changes (can’t be undone)', () => {
          if (confirm('Discard these changes? This can’t be undone.')) void this.act(() => window.api.gitApply(repo.root, patch(), { cached: false, reverse: true }), 'Discarding…')
        })
        btn('Stage Hunk', 'Put just these lines in the next commit', () => void this.act(() => window.api.gitApply(repo.root, patch(), { cached: true, reverse: false }), 'Staging…'))
      }
      box.append(h)
    }
    const table = document.createElement('div')
    table.className = 'diff-lines'
    for (const line of hunk.lines) {
      const row = document.createElement('div')
      row.className = `diff-line ${line.type === '+' ? 'add' : line.type === '-' ? 'del' : 'ctx'}`
      const o = document.createElement('span')
      o.className = 'diff-no'
      o.textContent = line.oldNo === null ? '' : String(line.oldNo)
      const n = document.createElement('span')
      n.className = 'diff-no'
      n.textContent = line.newNo === null ? '' : String(line.newNo)
      const mark = document.createElement('span')
      mark.className = 'diff-mark'
      mark.textContent = line.type === ' ' ? '' : line.type === '+' ? '+' : '−'
      const code = document.createElement('span')
      code.className = 'diff-code'
      this.fillCode(code, line.text, python)
      if (line.noNewline) code.title = 'No newline at the end of the file'
      row.append(o, n, mark, code)
      // Double-click a line to open the file there.
      if (line.newNo !== null && change.kind !== 'deleted') row.addEventListener('dblclick', () => this.hooks.openFile(this.abs(repo, change.path), line.newNo! - 1))
      table.append(row)
    }
    box.append(table)
    return box
  }

  /** Python lines get the editor's colors (each line on its own, which is fine for a diff). */
  private fillCode(el: HTMLElement, text: string, python: boolean): void {
    if (!python || text.length > 2000) {
      el.textContent = text
      return
    }
    let pos = 0
    for (const tok of tokenizeLine(text, '').tokens) {
      if (tok.start > pos) el.append(text.slice(pos, tok.start))
      const span = document.createElement('span')
      span.className = `tok-${tok.type}`
      span.textContent = text.slice(tok.start, tok.end)
      el.append(span)
      pos = tok.end
    }
    if (pos < text.length) el.append(text.slice(pos))
  }

  private async act(action: () => Promise<{ ok: boolean; error?: string; output: string }>, busy: string): Promise<void> {
    if (await this.hooks.run(action, busy)) await this.reload()
  }
}
