/**
 * App-wide commands and their keyboard shortcuts.
 *
 * Every action (save, run, open settings...) is registered here once, with a
 * title and an optional shortcut. The global key handler and the command
 * palette both use this list, so a new feature only needs registering once.
 */

export interface Command {
  id: string
  title: string
  /** Shortcut like 'Ctrl+S', 'Ctrl+Shift+P', 'F5'. */
  keys?: string
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
  const key = e.code === 'Backquote' ? '`' : e.key
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()

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
    const key = keyString(e)
    if (!key) return false
    for (const c of this.commands.values()) {
      if (c.keys === key && (!c.when || c.when())) {
        void c.run()
        return true
      }
    }
    return false
  }
}
