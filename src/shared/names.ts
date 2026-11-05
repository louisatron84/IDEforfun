/** Checks for file and folder names typed by the user (shared by the tree UI and the main process). */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * Why a name typed in the tree can't be used, or null if it's fine.
 * `allowNested` lets "pkg/mod.py" create the folder "pkg" on the way.
 */
export function nameProblem(name: string, allowNested = true): string | null {
  if (!name.trim()) return 'A name is required.'
  const parts = name.split(/[\\/]/)
  if (parts.length > 1 && !allowNested) return 'The name can\'t contain / or \\.'
  if (/^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return 'Use a name inside this folder, not a full path.'
  for (const part of parts) {
    if (!part) return 'The name has an empty part (two slashes in a row, or a slash at the end).'
    if (part === '.' || part === '..') return `"${part}" isn't allowed as a name.`
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) return 'Names can\'t contain < > : " | ? *'
    if (/[. ]$/.test(part)) return 'Names can\'t end with a dot or a space.'
    if (WINDOWS_RESERVED.test(part)) return `"${part}" is a reserved name on Windows.`
  }
  return null
}
