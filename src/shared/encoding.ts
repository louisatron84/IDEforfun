/** Text encodings the editor can open and save files in. */
export type Encoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'latin1'

export const ENCODINGS: { id: Encoding; label: string }[] = [
  { id: 'utf8', label: 'UTF-8' },
  { id: 'utf8bom', label: 'UTF-8 with BOM' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' },
  { id: 'latin1', label: 'Western (ISO 8859-1)' }
]

export const encodingLabel = (e: Encoding) => ENCODINGS.find((x) => x.id === e)?.label ?? e

/** What reading a file for the editor gave. */
export type TextFileResult =
  | { kind: 'text'; text: string; encoding: Encoding; size: number }
  /** Has NUL bytes: probably not text. Pass `force` to open it anyway. */
  | { kind: 'binary'; size: number }
  /** Big enough to ask first. Pass `force` to open it anyway. */
  | { kind: 'huge'; size: number }
  /** Too big to open at all. */
  | { kind: 'tooLarge'; size: number }

/** Files above this open in "large file mode": no language server, to stay responsive. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024
/** Files above this ask before opening. */
export const HUGE_FILE_BYTES = 50 * 1024 * 1024
/** Files above this aren't opened. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024
