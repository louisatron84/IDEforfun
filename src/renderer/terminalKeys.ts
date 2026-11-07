/**
 * Keys a focused terminal leaves to Forge instead of sending to the shell.
 * Forge tells it which (every shortcut bound to a command it lets through the
 * terminal: switching task, Open Folder, Ctrl+J...), so the terminal and the
 * shortcut list can't disagree. Until then: switching task (Ctrl+Alt+1…4) and
 * the Project Graph (Ctrl+Alt+G).
 */
type KeyLike = { key: string; code?: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey?: boolean }

let check: ((e: KeyLike) => boolean) | null = null

/** Forge's check: is this key one of its shortcuts that should work from the terminal? */
export function setAppShortcutCheck(fn: ((e: KeyLike) => boolean) | null): void {
  check = fn
}

export function isAppShortcut(e: KeyLike): boolean {
  if (check) return check(e)
  if (!(e.ctrlKey || e.metaKey) || !e.altKey) return false
  const key = e.key.toLowerCase()
  return ['1', '2', '3', '4', 'g'].includes(key) || /^Digit[1-4]$/.test(e.code ?? '') || e.code === 'KeyG'
}
