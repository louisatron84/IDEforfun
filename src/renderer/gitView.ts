/**
 * The Git tab in the sidebar (Source Control): the branch, a commit box, and
 * the changed files in three groups (merge conflicts, staged, changes).
 * Click a file to see its diff; hover for open / stage / unstage / discard.
 */
import type { RepoStatus, FileChange } from '../shared/git'

export type Repo = RepoStatus & { root: string }

export interface GitViewHooks {
  folder(): string | null
  /** Show the diff of a file (staged = what's in the index vs the last commit). */
  openDiff(repo: Repo, change: FileChange, staged: boolean): void
  openFile(absPath: string): void
  /** Run a git action; the view refreshes afterwards. Returns whether it worked. */
  run(action: () => Promise<{ ok: boolean; error?: string; output: string }>, busyText: string): Promise<boolean>
  /** Delete untracked files (to the trash). */
  trash(absPaths: string[]): Promise<void>
  pickBranch(): void
  refresh(): void
}

const LETTER: Record<FileChange['kind'], string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!', typechange: 'T'
}

export class GitView {
  readonly root: HTMLDivElement
  private repo: Repo | null = null
  private loaded = false
  private busy = ''
  private readonly message: HTMLTextAreaElement
  private amend = false

  constructor(private readonly hooks: GitViewHooks) {
    this.root = document.createElement('div')
    this.root.className = 'git-view'
    this.message = document.createElement('textarea')
    this.message.className = 'git-message'
    this.message.rows = 3
    this.message.spellcheck = true
    this.message.setAttribute('aria-label', 'Commit message')
    this.message.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void this.commit()
      }
    })
    this.message.addEventListener('input', () => this.updateCommitButton())
    this.render()
  }

  get status(): Repo | null {
    return this.repo
  }

  setStatus(repo: Repo | null): void {
    this.repo = repo
    this.loaded = true
    this.render()
  }

  setBusy(text: string): void {
    this.busy = text
    this.render()
  }

  focusMessage(): void {
    this.message.focus()
  }

  private abs(path: string): string {
    const root = this.repo!.root
    const sep = root.includes('\\') ? '\\' : '/'
    return root.replace(/[\\/]+$/, '') + sep + path.split('/').join(sep)
  }

  private commitButton: HTMLButtonElement | null = null

  private updateCommitButton(): void {
    const b = this.commitButton
    if (!b || !this.repo) return
    const hasChanges = this.repo.staged.length > 0 || this.repo.unstaged.length > 0 || this.amend
    b.disabled = !this.message.value.trim() || !hasChanges || !!this.busy || this.repo.conflicts.length > 0
  }

  /** Commit what's staged (offering to stage everything if nothing is). */
  async commit(): Promise<void> {
    const repo = this.repo
    const msg = this.message.value.trim()
    if (!repo) return
    if (!msg) {
      this.message.focus()
      return
    }
    if (repo.conflicts.length) {
      alert('Resolve the merge conflicts first (fix the files, then stage them).')
      return
    }
    let all = false
    if (!repo.staged.length && !this.amend) {
      if (!repo.unstaged.length) return
      if (!confirm(`Nothing is staged. Stage all ${repo.unstaged.length} changed file${repo.unstaged.length === 1 ? '' : 's'} and commit them?`)) return
      all = true
    }
    const ok = await this.hooks.run(() => window.api.gitCommit(repo.root, msg, { amend: this.amend, all }), this.amend ? 'Amending…' : 'Committing…')
    if (ok) {
      this.message.value = ''
      this.amend = false
      this.render()
    }
  }

  private render(): void {
    const folder = this.hooks.folder()
    const repo = this.repo
    const out: HTMLElement[] = []
    if (!folder) {
      this.root.replaceChildren(this.note('Open a folder to use git.'))
      return
    }
    if (!this.loaded) {
      this.root.replaceChildren(this.note('Reading git status…'))
      return
    }
    if (!repo) {
      const box = this.note("This folder isn't a git repository.")
      const init = this.button('Initialize Repository', 'Run git init here', () => void this.hooks.run(() => window.api.gitInit(folder), 'Creating repository…'), 'git-primary')
      box.append(document.createElement('br'), init)
      this.root.replaceChildren(box)
      return
    }

    // Branch and sync
    const head = document.createElement('div')
    head.className = 'git-head'
    const branch = document.createElement('button')
    branch.className = 'git-branch'
    const name = repo.detached ? 'detached HEAD' : repo.branch ?? '?'
    const ab = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ')
    branch.textContent = `⎇ ${name}${ab ? '  ' + ab : ''}`
    branch.title = repo.upstream ? `Tracks ${repo.upstream}. Click to switch or create a branch.` : 'No upstream yet (Push sets one). Click to switch or create a branch.'
    branch.addEventListener('click', () => this.hooks.pickBranch())
    head.append(
      branch,
      this.button('⟳', 'Refresh', () => this.hooks.refresh()),
      this.button('Fetch', 'Fetch from the remote (git fetch)', () => void this.hooks.run(() => window.api.gitSync(repo.root, 'fetch'), 'Fetching…')),
      this.button(repo.behind ? `Pull ↓${repo.behind}` : 'Pull', 'Pull (git pull)', () => void this.hooks.run(() => window.api.gitSync(repo.root, 'pull'), 'Pulling…')),
      this.button(repo.ahead ? `Push ↑${repo.ahead}` : 'Push', repo.upstream ? `Push to ${repo.upstream}` : 'Push (and set the upstream)', () => void this.hooks.run(() => window.api.gitSync(repo.root, 'push'), 'Pushing…'))
    )
    out.push(head)

    // Commit box
    const box = document.createElement('div')
    box.className = 'git-commit'
    this.message.placeholder = `Message (Ctrl+Enter to commit on "${name}")`
    const row = document.createElement('div')
    row.className = 'git-commit-row'
    const commit = this.button(this.amend ? 'Amend Commit' : 'Commit', 'Commit the staged changes (Ctrl+Enter)', () => void this.commit(), 'git-primary')
    this.commitButton = commit
    const amendLabel = document.createElement('label')
    amendLabel.className = 'git-amend'
    const amend = document.createElement('input')
    amend.type = 'checkbox'
    amend.checked = this.amend
    amend.disabled = repo.initial
    amend.addEventListener('change', () => {
      this.amend = amend.checked
      // Start from the last message when amending.
      if (this.amend && !this.message.value.trim()) void window.api.gitLastMessage(repo.root).then((m) => { if (this.amend && !this.message.value.trim()) this.message.value = m })
      this.render()
    })
    amendLabel.append(amend, document.createTextNode(' Amend'))
    amendLabel.title = 'Change the last commit instead of making a new one'
    row.append(commit, amendLabel)
    box.append(this.message, row)
    out.push(box)
    if (this.busy) {
      const b = this.note(this.busy)
      b.classList.add('git-busy')
      out.push(b)
    }

    if (repo.conflicts.length) {
      out.push(this.section('Merge Conflicts', repo.conflicts, false, [
        ['Stage all', 'Mark all as resolved (stage them)', () => void this.hooks.run(() => window.api.gitStage(repo.root, repo.conflicts.map((c) => c.path)), 'Staging…')]
      ]))
    }
    if (repo.staged.length) {
      out.push(this.section('Staged Changes', repo.staged, true, [
        ['−', 'Unstage all', () => void this.hooks.run(() => window.api.gitUnstage(repo.root, repo.staged.map((c) => c.path)), 'Unstaging…')]
      ]))
    }
    out.push(this.section('Changes', repo.unstaged, false, [
      ['↶', 'Discard all changes', () => void this.discard(repo.unstaged)],
      ['+', 'Stage all', () => void this.hooks.run(() => window.api.gitStage(repo.root, repo.unstaged.map((c) => c.path)), 'Staging…')]
    ]))
    if (!repo.staged.length && !repo.unstaged.length && !repo.conflicts.length) {
      out.push(this.note(repo.initial ? 'No commits yet. Create or change files, then commit them.' : 'No changes. Everything is committed.'))
    }
    this.root.replaceChildren(...out)
    this.updateCommitButton()
  }

  private section(title: string, list: FileChange[], staged: boolean, actions: [string, string, () => void][]): HTMLElement {
    const repo = this.repo!
    const sec = document.createElement('div')
    sec.className = 'git-section'
    const h = document.createElement('div')
    h.className = 'git-section-head'
    const label = document.createElement('span')
    label.textContent = title
    const count = document.createElement('span')
    count.className = 'search-file-count'
    count.textContent = String(list.length)
    h.append(label, count)
    if (list.length) for (const [text, tip, fn] of actions) h.append(this.button(text, tip, fn, 'git-mini'))
    sec.append(h)
    for (const change of list) {
      const row = document.createElement('div')
      row.className = 'git-file'
      row.tabIndex = 0
      const slash = change.path.lastIndexOf('/')
      const fname = document.createElement('span')
      fname.className = 'git-file-name'
      fname.textContent = change.path.slice(slash + 1)
      const dir = document.createElement('span')
      dir.className = 'git-file-dir'
      dir.textContent = change.from ? `← ${change.from}` : slash > 0 ? change.path.slice(0, slash) : ''
      const letter = document.createElement('span')
      letter.className = `git-letter kind-${change.kind}`
      letter.textContent = LETTER[change.kind]
      letter.title = change.kind
      const buttons = document.createElement('span')
      buttons.className = 'git-file-buttons'
      if (change.kind !== 'deleted') buttons.append(this.button('📄', 'Open file', () => this.hooks.openFile(this.abs(change.path)), 'git-mini'))
      if (staged) buttons.append(this.button('−', 'Unstage', () => void this.hooks.run(() => window.api.gitUnstage(repo.root, [change.path]), 'Unstaging…'), 'git-mini'))
      else {
        buttons.append(this.button('↶', change.kind === 'untracked' ? 'Delete this new file' : 'Discard changes', () => void this.discard([change]), 'git-mini'))
        buttons.append(this.button('+', change.kind === 'conflict' ? 'Mark resolved (stage)' : 'Stage', () => void this.hooks.run(() => window.api.gitStage(repo.root, [change.path]), 'Staging…'), 'git-mini'))
      }
      row.append(fname, dir, buttons, letter)
      row.title = `${change.path}${change.from ? ` (renamed from ${change.from})` : ''}\nClick to see the changes`
      const open = () => (change.kind === 'conflict' ? this.hooks.openFile(this.abs(change.path)) : this.hooks.openDiff(repo, change, staged))
      row.addEventListener('click', open)
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open()
      })
      sec.append(row)
    }
    return sec
  }

  /** Discard unstaged changes (and delete untracked files), after asking. */
  private async discard(changes: FileChange[]): Promise<void> {
    const repo = this.repo
    if (!repo || !changes.length) return
    const untracked = changes.filter((c) => c.kind === 'untracked')
    const tracked = changes.filter((c) => c.kind !== 'untracked')
    const parts = [
      tracked.length ? `discard the changes to ${tracked.length === 1 ? tracked[0].path : `${tracked.length} files`}` : '',
      untracked.length ? `delete ${untracked.length === 1 ? `the new file ${untracked[0].path}` : `${untracked.length} new files`} (to the trash)` : ''
    ].filter(Boolean)
    if (!confirm(`Really ${parts.join(' and ')}? Discarded changes can't be undone.`)) return
    await this.hooks.run(async () => {
      if (tracked.length) {
        const r = await window.api.gitDiscard(repo.root, tracked.map((c) => c.path))
        if (!r.ok) return r
      }
      if (untracked.length) await this.hooks.trash(untracked.map((c) => this.abs(c.path)))
      return { ok: true, output: '' }
    }, 'Discarding…')
  }

  private note(text: string): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'problems-empty git-note'
    el.textContent = text
    return el
  }

  private button(text: string, title: string, fn: () => void, cls = 'git-button'): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = cls
    b.textContent = text
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }
}
