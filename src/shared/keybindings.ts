/**
 * User keyboard shortcuts (userData/keybindings.json).
 *
 * The file maps command ids to keys and only lists the commands you changed:
 *   { "run.file": "Ctrl+R", "palette.files": ["Ctrl+P", "Ctrl+E"], "nav.back": null }
 * A string or list replaces the command's default keys; null (or []) removes them.
 */

export type KeyOverrides = Record<string, string[]>

const MODIFIERS: Record<string, 'Ctrl' | 'Shift' | 'Alt'> = {
  ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Ctrl', command: 'Ctrl', meta: 'Ctrl', cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt', option: 'Alt'
}

const KEY_NAMES: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  plus: '+', backquote: '`'
}

/**
 * Write a shortcut the way keyString() produces it ('ctrl+shift+p' → 'Ctrl+Shift+P'),
 * or return null if it isn't a usable shortcut.
 */
export function normalizeKey(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  // Split on '+', but a trailing '+' is the key itself (Ctrl++).
  const parts = text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+')
  const mods = new Set<string>()
  let key: string | null = null
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) return null
    const mod = MODIFIERS[p.toLowerCase()]
    if (mod) {
      mods.add(mod)
      continue
    }
    if (key !== null) return null // two non-modifier keys
    const named = KEY_NAMES[p.toLowerCase()]
    if (named) key = named
    else if (/^f([1-9]|1\d|2[0-4])$/i.test(p)) key = p.toUpperCase()
    else if ([...p].length === 1) key = p.toUpperCase()
    else return null
  }
  if (key === null) return null
  const out: string[] = []
  for (const m of ['Ctrl', 'Shift', 'Alt']) if (mods.has(m)) out.push(m)
  out.push(key)
  return out.join('+')
}

/** Read keybindings.json content (anything; bad entries are dropped) into overrides. */
export function normalizeKeybindings(raw: unknown): KeyOverrides {
  const out: KeyOverrides = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w.-]+$/.test(id)) continue
    if (value === null) {
      out[id] = []
      continue
    }
    const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
    if (!list) continue
    const keys: string[] = []
    for (const v of list) {
      const k = typeof v === 'string' ? normalizeKey(v) : null
      if (k && !keys.includes(k)) keys.push(k)
    }
    // A list of only bad keys is a typo, not "remove the shortcut".
    if (keys.length || list.length === 0) out[id] = keys
  }
  return out
}

/** Keys used by more than one command: key → command ids. */
export function findConflicts(bindings: { id: string; keys: string[] }[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const b of bindings) {
    for (const k of b.keys) {
      const ids = byKey.get(k) ?? []
      if (!ids.includes(b.id)) ids.push(b.id)
      byKey.set(k, ids)
    }
  }
  for (const [k, ids] of byKey) if (ids.length < 2) byKey.delete(k)
  return byKey
}

/** 'Ctrl+Shift+P' → 'CmdOrCtrl+Shift+P' for Electron's menu labels. */
export function toAccelerator(key: string): string {
  return key.replace(/^Ctrl\+/, 'CmdOrCtrl+')
    .replace(/Arrow(Up|Down|Left|Right)$/, '$1')
}
