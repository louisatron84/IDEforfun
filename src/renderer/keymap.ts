/**
 * App-wide commands and their keyboard shortcuts.
 *
 * Every action (save, run, open settings...) is registered here once, with a
 * title and an optional shortcut. The global key handler and the command
 * palette both use this list, so a new feature only needs registering once.
 * Your changes from keybindings.json (setOverrides) replace a command's
 * default keys.
 */
import type { KeyOverrides } from '../shared/keybindings'

export interface Command {
  id: string
  title: string
  /** Shortcut like 'Ctrl+S', 'Ctrl+Shift+P', 'F5' (or several; the first is the one shown). */
  keys?: string | string[]
  /** Only available when this returns true (e.g. "Run" needs an open file). */
  when?: () => boolean
  run: () => void | Promise<void>
}

/** Turn a key event into a shortcut string such as 'Ctrl+Shift+P'. Cmd counts as Ctrl. */
export function keyString(e: KeyboardEvent): string {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  // The key left of 1 is ` whatever Shift makes it type (~ on US keyboards, ¬ on UK ones).
  const key = e.code === 'Backquote' ? '`' : e.key === ' ' ? 'Space' : e.key
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  private overrides: KeyOverrides = {}

  /** Use these keys instead of the defaults for the commands listed. */
  setOverrides(overrides: KeyOverrides): void {
    this.overrides = overrides
  }

  getOverrides(): KeyOverrides {
    return { ...this.overrides }
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  /** The keys a command has when nothing is changed. */
  defaultKeys(id: string): string[] {
    const keys = this.commands.get(id)?.keys
    return typeof keys === 'string' ? [keys] : keys ?? []
  }

  /** The keys that run a command now (your change, or the default). */
  keysOf(id: string): string[] {
    return this.overrides[id] ?? this.defaultKeys(id)
  }

  /** The command a key would run right now, if any. */
  commandForKey(key: string): Command | undefined {
    if (!key) return undefined
    for (const c of this.commands.values()) {
      if (this.keysOf(c.id).includes(key) && (!c.when || c.when())) return c
    }
    return undefined
  }

  /** First shortcut of every command, for the menu bar (null = none). */
  menuKeys(): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const id of this.commands.keys()) out[id] = this.keysOf(id)[0] ?? null
    return out
  }

  register(command: Command): void {
    this.commands.set(command.id, command)
  }

  all(): Command[] {
    return [...this.commands.values()]
  }

  available(): Command[] {
    return this.all().filter((c) => !c.when || c.when())
  }

  run(id: string): void {
    const c = this.commands.get(id)
    if (c && (!c.when || c.when())) void c.run()
  }

  /** Run the command bound to this key, if any. Returns true if one ran. */
  handleKey(e: KeyboardEvent): boolean {
    const c = this.commandForKey(keyString(e))
    if (!c) return false
    void c.run()
    return true
  }
}
