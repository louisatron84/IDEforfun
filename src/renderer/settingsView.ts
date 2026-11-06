/**
 * The Settings screen (Ctrl+, or the ⚙ button): a small dialog whose
 * controls apply live and save automatically.
 */
import type { Settings } from '../shared/settings'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../shared/settings'

export class SettingsView {
  private readonly overlay: HTMLDivElement
  private readonly dialog: HTMLDivElement
  private settings: Settings
  private saveTimer: number | undefined
  private returnFocus: HTMLElement | null = null
  /** Which settings the open project overrides, and where (shown as a note). */
  private projectNote: string | null = null
  private links: { label: string; run: () => void }[] = []

  constructor(initial: Settings, private readonly onChange: (s: Settings) => void) {
    this.settings = { ...initial }
    this.overlay = document.createElement('div')
    this.overlay.className = 'overlay'
    this.overlay.hidden = true
    this.dialog = document.createElement('div')
    this.dialog.className = 'settings-dialog'
    this.dialog.setAttribute('role', 'dialog')
    this.dialog.setAttribute('aria-modal', 'true')
    this.dialog.setAttribute('aria-labelledby', 'settings-title')
    this.overlay.append(this.dialog)
    document.body.append(this.overlay)

    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close() // click outside the dialog
    })
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.close()
      }
    })
    this.render()
  }

  get isOpen(): boolean {
    return !this.overlay.hidden
  }

  /** Update from outside (e.g. settings finished loading from disk). */
  set(settings: Settings): void {
    this.settings = { ...settings }
    this.render()
  }

  /** Say which settings the project's .ideforfun/settings.json overrides (null = none). */
  setProjectNote(note: string | null): void {
    this.projectNote = note
    if (this.isOpen) this.render()
  }

  /** Buttons at the bottom (e.g. Keyboard Shortcuts…, Project Settings…). */
  setLinks(links: { label: string; run: () => void }[]): void {
    this.links = links
    this.render()
  }

  open(): void {
    this.returnFocus = document.activeElement as HTMLElement | null
    this.render()
    this.overlay.hidden = false
    this.dialog.querySelector<HTMLElement>('input, button')?.focus()
  }

  close(): void {
    if (!this.isOpen) return
    this.overlay.hidden = true
    this.returnFocus?.focus()
  }

  private update(patch: Partial<Settings>, debounce = false): void {
    this.settings = { ...this.settings, ...patch }
    window.clearTimeout(this.saveTimer)
    const apply = () => this.onChange({ ...this.settings })
    if (debounce) this.saveTimer = window.setTimeout(apply, 120)
    else apply()
  }

  private render(): void {
    const s = this.settings
    this.dialog.replaceChildren()

    const header = document.createElement('div')
    header.className = 'settings-header'
    const title = document.createElement('h2')
    title.id = 'settings-title'
    title.textContent = 'Settings'
    const close = document.createElement('button')
    close.className = 'icon-button'
    close.textContent = '×'
    close.setAttribute('aria-label', 'Close settings')
    close.addEventListener('click', () => this.close())
    header.append(title, close)

    // Font size
    const fontValue = document.createElement('span')
    fontValue.className = 'setting-value'
    fontValue.textContent = `${s.fontSize}px`
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = String(FONT_SIZE_MIN)
    slider.max = String(FONT_SIZE_MAX)
    slider.value = String(s.fontSize)
    slider.id = 'setting-font-size'
    slider.addEventListener('input', () => {
      fontValue.textContent = `${slider.value}px`
      this.update({ fontSize: Number(slider.value) }, true)
    })
    const fontRow = this.row('Font size', 'Editor and terminal text', slider, fontValue)
    fontRow.querySelector('label')!.htmlFor = slider.id

    // Theme
    const themeRow = this.row('Theme', 'Colors for the whole IDE',
      this.segmented('theme', [['dark', 'Dark'], ['light', 'Light']], s.theme, (v) => this.update({ theme: v as Settings['theme'] })))

    // Tab width
    const tabRow = this.row('Tab width', 'Spaces per indent level (Python uses 4)',
      this.segmented('tab', [['2', '2'], ['4', '4'], ['8', '8']], String(s.tabSize), (v) => this.update({ tabSize: Number(v) as Settings['tabSize'] })))

    // Python interpreter
    const py = document.createElement('input')
    py.type = 'text'
    py.id = 'setting-python'
    py.className = 'setting-text'
    py.placeholder = 'Automatic: project .venv, then python on PATH'
    py.value = s.pythonPath
    py.spellcheck = false
    py.addEventListener('input', () => this.update({ pythonPath: py.value.trim() }, true))
    const pyRow = this.row('Python interpreter', 'Used by Run (F5). Leave empty for automatic.', py)
    pyRow.classList.add('stacked')
    pyRow.querySelector('label')!.htmlFor = py.id

    // Terminal shell
    const shell = document.createElement('select')
    shell.id = 'setting-shell'
    shell.className = 'setting-select'
    const fill = (shells: { id: string; name: string }[]) => {
      shell.replaceChildren(...[{ id: '', name: 'System default' }, ...shells].map((o) => {
        const opt = document.createElement('option')
        opt.value = o.id
        opt.textContent = o.name
        return opt
      }))
      shell.value = s.shell
    }
    fill([])
    void window.api.terminalShells().then(fill).catch(() => {})
    shell.addEventListener('change', () => this.update({ shell: shell.value }))
    const shellRow = this.row('Terminal shell', 'Used for new terminals', shell)
    shellRow.querySelector('label')!.htmlFor = shell.id

    // Reopen the last project at startup
    const reopen = document.createElement('input')
    reopen.type = 'checkbox'
    reopen.id = 'setting-reopen'
    reopen.checked = s.reopenLastProject
    reopen.addEventListener('change', () => this.update({ reopenLastProject: reopen.checked }))
    const reopenRow = this.row('Reopen last project', 'At startup, open the last folder with its tabs and layout', reopen)
    reopenRow.querySelector('label')!.htmlFor = reopen.id

    // Formatting and linting
    const fmtRow = this.row('Formatter', 'For Format Document (Shift+Alt+F). Auto: Ruff if installed, else Black',
      this.segmented('formatter', [['auto', 'Auto'], ['ruff', 'Ruff'], ['black', 'Black']], s.formatter, (v) => this.update({ formatter: v as Settings['formatter'] })))
    const fos = document.createElement('input')
    fos.type = 'checkbox'
    fos.id = 'setting-format-on-save'
    fos.checked = s.formatOnSave
    fos.addEventListener('change', () => this.update({ formatOnSave: fos.checked }))
    const fosRow = this.row('Format on save', 'Format Python files every time they are saved', fos)
    fosRow.querySelector('label')!.htmlFor = fos.id
    const lint = document.createElement('input')
    lint.type = 'checkbox'
    lint.id = 'setting-ruff'
    lint.checked = s.lintWithRuff
    lint.addEventListener('change', () => this.update({ lintWithRuff: lint.checked }))
    const lintRow = this.row('Ruff warnings', "Show Ruff's lint warnings and quick fixes (when Ruff is installed)", lint)
    lintRow.querySelector('label')!.htmlFor = lint.id

    const dbg = document.createElement('input')
    dbg.type = 'checkbox'
    dbg.id = 'setting-debug-terminal'
    dbg.checked = s.debugInTerminal
    dbg.addEventListener('change', () => this.update({ debugInTerminal: dbg.checked }))
    const dbgRow = this.row('Debug in terminal', 'Run the program being debugged in a terminal, so input() works', dbg)
    dbgRow.querySelector('label')!.htmlFor = dbg.id

    const rows: HTMLElement[] = [header]
    if (this.projectNote) {
      const note = document.createElement('p')
      note.className = 'settings-note'
      note.textContent = this.projectNote
      rows.push(note)
    }
    rows.push(fontRow, themeRow, tabRow, pyRow, shellRow, fmtRow, fosRow, lintRow, dbgRow, reopenRow)

    if (this.links.length) {
      const linkRow = document.createElement('div')
      linkRow.className = 'settings-links'
      for (const l of this.links) {
        const b = document.createElement('button')
        b.textContent = l.label
        b.addEventListener('click', () => {
          this.close()
          l.run()
        })
        linkRow.append(b)
      }
      rows.push(linkRow)
    }

    const footer = document.createElement('p')
    footer.className = 'settings-footer'
    footer.textContent = 'Changes apply immediately and are saved automatically.'
    rows.push(footer)

    this.dialog.append(...rows)
  }

  private row(label: string, hint: string, ...controls: HTMLElement[]): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'setting-row'
    const text = document.createElement('div')
    text.className = 'setting-text-block'
    const l = document.createElement('label')
    l.textContent = label
    const h = document.createElement('div')
    h.className = 'setting-hint'
    h.textContent = hint
    text.append(l, h)
    const ctl = document.createElement('div')
    ctl.className = 'setting-control'
    ctl.append(...controls)
    row.append(text, ctl)
    return row
  }

  private segmented(name: string, options: [string, string][], value: string, onPick: (v: string) => void): HTMLElement {
    const group = document.createElement('div')
    group.className = 'segmented'
    group.setAttribute('role', 'radiogroup')
    group.dataset.setting = name
    for (const [v, label] of options) {
      const b = document.createElement('button')
      b.textContent = label
      b.dataset.value = v
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(v === value))
      b.addEventListener('click', () => {
        for (const other of group.querySelectorAll('button')) other.setAttribute('aria-checked', String(other === b))
        onPick(v)
      })
      group.append(b)
    }
    return group
  }
}
