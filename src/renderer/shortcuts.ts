/**
 * Changing keyboard shortcuts. "Keyboard Shortcuts…" lists every command with
 * its keys (clashes are marked); pick one to press new keys, remove them or
 * go back to the default. Changes are saved in keybindings.json, which can
 * also be edited by hand ("Edit Keyboard Shortcuts File").
 */
import type { KeyOverrides } from '../shared/keybindings'
import { findConflicts } from '../shared/keybindings'
import type { CommandRegistry } from './keymap'
import type { Palette } from './palette'

const show = (keys: string[]) => (keys.length ? keys.join('  or  ') : 'no shortcut')

export class Shortcuts {
  /** Path of keybindings.json (known after load). */
  path = ''

  constructor(
    private readonly commands: CommandRegistry,
    private readonly palette: Palette,
    private readonly report: (message: string) => void
  ) {}

  /** Read keybindings.json and apply it. Called at startup and after the file is saved. */
  async load(): Promise<void> {
    try {
      const res = await window.api.getKeybindings()
      this.path = res.path
      this.commands.setOverrides(res.overrides)
      if (res.error) this.report(`Your keyboard shortcuts file couldn't be read, so the defaults are used.\n${res.path}\n${res.error}`)
      const unknown = Object.keys(res.overrides).filter((id) => !this.commands.get(id))
      if (unknown.length) console.warn('keybindings.json mentions unknown commands:', unknown)
    } catch (err) {
      this.report(`Couldn't load your keyboard shortcuts: ${String(err)}`)
    }
    this.syncMenu()
  }

  private syncMenu(): void {
    window.api.setMenuKeys(this.commands.menuKeys())
  }

  /** Keys shared by several commands: key → command titles. */
  private conflicts(): Map<string, string[]> {
    const all = this.commands.all().map((c) => ({ id: c.id, keys: this.commands.keysOf(c.id) }))
    const out = new Map<string, string[]>()
    for (const [key, ids] of findConflicts(all)) out.set(key, ids.map((id) => this.commands.get(id)?.title ?? id))
    return out
  }

  /** The list of every command and its keys. */
  showList(): void {
    const conflicts = this.conflicts()
    const overrides = this.commands.getOverrides()
    const items = this.commands.all()
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => {
        const keys = this.commands.keysOf(c.id)
        const clashes = keys.filter((k) => conflicts.has(k))
        const notes: string[] = []
        if (c.id in overrides) notes.push('changed')
        if (clashes.length) {
          const others = clashes.flatMap((k) => conflicts.get(k)!.filter((t) => t !== c.title))
          notes.push(`⚠ also used by ${[...new Set(others)].join(', ')}`)
        }
        return {
          label: c.title,
          detail: notes.join(' · ') || undefined,
          hint: keys.length ? keys.join(', ') : '—',
          run: () => setTimeout(() => this.editOne(c.id))
        }
      })
    this.palette.choose(`Keyboard shortcuts (${conflicts.size ? `${conflicts.size} clash${conflicts.size > 1 ? 'es' : ''}` : 'no clashes'}): pick one to change it`, items)
  }

  private editOne(id: string): void {
    const c = this.commands.get(id)
    if (!c) return
    const keys = this.commands.keysOf(id)
    const defaults = this.commands.defaultKeys(id)
    const changed = id in this.commands.getOverrides()
    const choices = [
      { label: 'Change shortcut…', detail: `now: ${show(keys)}`, run: () => setTimeout(() => this.capture(id, false)) },
      ...(keys.length ? [{ label: 'Add another shortcut…', detail: 'keep the current one too', run: () => setTimeout(() => this.capture(id, true)) }] : []),
      ...(keys.length ? [{ label: 'Remove shortcut', run: () => void this.save(id, []) }] : []),
      ...(changed ? [{ label: 'Reset to default', detail: show(defaults), run: () => void this.save(id, null) }] : []),
      { label: '← Back to all shortcuts', run: () => setTimeout(() => this.showList()) }
    ]
    this.palette.choose(c.title, choices)
  }

  private capture(id: string, add: boolean): void {
    const title = this.commands.get(id)?.title ?? id
    this.palette.captureKey(`New shortcut for "${title}"`, (key) => {
      const current = this.commands.keysOf(id)
      const next = add ? [...current.filter((k) => k !== key), key] : [key]
      const others = this.commands.all().filter((c) => c.id !== id && this.commands.keysOf(c.id).includes(key))
      if (!others.length) {
        this.palette.close()
        void this.save(id, next)
        return
      }
      const names = others.map((c) => c.title).join(', ')
      this.palette.choose(`${key} is already used by ${names}`, [
        { label: `Use ${key} for "${title}" and remove it from ${names}`, run: () => void this.save(id, next, others.map((c) => c.id), key) },
        { label: `Use ${key} for both`, detail: 'whichever is available at the time runs; the first listed wins', run: () => void this.save(id, next) },
        { label: 'Pick a different shortcut…', run: () => setTimeout(() => this.capture(id, add)) },
        { label: 'Cancel', run: () => {} }
      ])
    })
  }

  /**
   * Save `keys` for a command (null = back to the default), optionally
   * taking `key` away from other commands.
   */
  private async save(id: string, keys: string[] | null, takeFrom: string[] = [], key = ''): Promise<void> {
    const overrides: KeyOverrides = this.commands.getOverrides()
    if (keys === null) delete overrides[id]
    else overrides[id] = keys
    for (const other of takeFrom) overrides[other] = this.commands.keysOf(other).filter((k) => k !== key)
    // Don't store what's the same as the default.
    for (const [cid, k] of Object.entries(overrides)) {
      const d = this.commands.defaultKeys(cid)
      if (k.length === d.length && k.every((x, i) => x === d[i])) delete overrides[cid]
    }
    try {
      await window.api.saveKeybindings(overrides)
      this.commands.setOverrides(overrides)
      this.syncMenu()
    } catch (err) {
      this.report(`Couldn't save the shortcut: ${String(err)}`)
    }
  }

  /** Open keybindings.json in the editor. */
  async openFile(open: (path: string) => void): Promise<void> {
    try {
      this.path = await window.api.ensureKeybindingsFile()
      open(this.path)
    } catch (err) {
      this.report(`Couldn't create the shortcuts file: ${String(err)}`)
    }
  }
}
