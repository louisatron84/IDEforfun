/**
 * Keys a focused terminal leaves to Forge instead of sending to the shell:
 * switching task (Ctrl+Alt+1…4) and the Project Graph (Ctrl+Alt+G).
 */
export function isAppShortcut(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (!(e.ctrlKey || e.metaKey) || !e.altKey) return false
  const key = e.key.toLowerCase()
  return ['1', '2', '3', '4', 'g'].includes(key) || /^Digit[1-4]$/.test(e.code ?? '') || e.code === 'KeyG'
}
