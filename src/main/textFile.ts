/**
 * Reading and writing files for the editor: detects the encoding (byte
 * order marks, else UTF-8 if valid, else Western/Latin-1), spots binary
 * files, and refuses files too big to open.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { HUGE_FILE_BYTES, MAX_FILE_BYTES, type Encoding, type TextFileResult } from '../shared/encoding'

/** NUL bytes near the start mean it's almost certainly not a text file. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function bomEncoding(buf: Buffer): Encoding | null {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8bom'
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  return null
}

function swapBytes(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1]
    out[i + 1] = buf[i]
  }
  return out
}

/** Decode with a known encoding (a byte order mark at the start is skipped). */
export function decodeAs(buf: Buffer, encoding: Encoding): string {
  const bom = bomEncoding(buf)
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      return buf.subarray(bom === 'utf8bom' ? 3 : 0).toString('utf8')
    case 'utf16le':
      return buf.subarray(bom === 'utf16le' ? 2 : 0).toString('utf16le')
    case 'utf16be':
      return swapBytes(buf.subarray(bom === 'utf16be' ? 2 : 0)).toString('utf16le')
    case 'latin1':
      return buf.toString('latin1')
  }
}

/** Guess the encoding and decode. */
export function decode(buf: Buffer): { text: string; encoding: Encoding } {
  const bom = bomEncoding(buf)
  if (bom) return { text: decodeAs(buf, bom), encoding: bom }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' }
  } catch {
    // Not valid UTF-8: most likely an old Windows/Western file.
    return { text: buf.toString('latin1'), encoding: 'latin1' }
  }
}

export function encode(text: string, encoding: Encoding): Buffer {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swapBytes(Buffer.from(text, 'utf16le'))])
    case 'latin1':
      return Buffer.from(text, 'latin1')
  }
}

export async function readTextFile(
  path: string,
  opts: { force?: boolean; encoding?: Encoding } = {}
): Promise<TextFileResult> {
  const { size } = await stat(path)
  if (size > MAX_FILE_BYTES) return { kind: 'tooLarge', size }
  if (size > HUGE_FILE_BYTES && !opts.force) return { kind: 'huge', size }
  const buf = await readFile(path)
  const bom = bomEncoding(buf)
  // UTF-16 text is full of NUL bytes, so only check files without a UTF-16 byte order mark.
  if (!opts.force && !opts.encoding && bom !== 'utf16le' && bom !== 'utf16be' && looksBinary(buf)) {
    return { kind: 'binary', size }
  }
  if (opts.encoding) return { kind: 'text', text: decodeAs(buf, opts.encoding), encoding: opts.encoding, size }
  return { kind: 'text', ...decode(buf), size }
}

export async function writeTextFile(path: string, text: string, encoding: Encoding): Promise<void> {
  await writeFile(path, encode(text, encoding))
}
