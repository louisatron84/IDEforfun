/**
 * Which language a file is, by its name. The editor uses this to pick
 * highlighting, comments and indentation (src/renderer/editor/modes.ts), and
 * the language services use `server` to send the file to the right language
 * server. Adding a language means adding an entry here (and, for a server, an
 * entry in src/main/languageServer.ts plus a client config in src/renderer/lsp/).
 */

export interface LanguageInfo {
  id: string
  /** Shown in the status bar. */
  name: string
  /** Lower-case, with the dot. */
  extensions: readonly string[]
  /** Exact file names (lower-case), for files without a telling extension. */
  fileNames?: readonly string[]
  /** The language server that handles it, if any (an id from the server registry). */
  server?: string
  /** The languageId sent to the server (defaults to `id`). */
  lspId?: string
}

export const PLAIN_TEXT: LanguageInfo = { id: 'plaintext', name: 'Plain Text', extensions: [] }

export const LANGUAGES: readonly LanguageInfo[] = [
  { id: 'python', name: 'Python', extensions: ['.py', '.pyi', '.pyw'], server: 'pyright' },
  { id: 'json', name: 'JSON', extensions: ['.json'] },
  // JSON with comments: editor and tool settings files that allow them.
  {
    id: 'jsonc',
    name: 'JSON with Comments',
    extensions: ['.jsonc'],
    fileNames: ['settings.json', 'keybindings.json', 'run.json', 'tsconfig.json', 'jsconfig.json', '.eslintrc.json']
  },
  { id: 'toml', name: 'TOML', extensions: ['.toml'], fileNames: ['pipfile'] },
  { id: 'yaml', name: 'YAML', extensions: ['.yaml', '.yml'] },
  { id: 'ini', name: 'INI', extensions: ['.ini', '.cfg', '.conf'], fileNames: ['.editorconfig', '.flake8', '.pylintrc', '.coveragerc'] },
  PLAIN_TEXT
]

/** The language of a file (Plain Text if nothing matches). */
export function languageForPath(path: string): LanguageInfo {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  for (const lang of LANGUAGES) if (lang.fileNames?.includes(name)) return lang
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return PLAIN_TEXT
  const ext = name.slice(dot)
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? PLAIN_TEXT
}

export function languageById(id: string): LanguageInfo {
  return LANGUAGES.find((l) => l.id === id) ?? PLAIN_TEXT
}
