/**
 * Finding and changing a box's marked block in a Python file. Forge only
 * ever touches the text between (and including) its own two marker lines;
 * anything odd about the markers means "broken", and Forge stops writing.
 */
import type { ApiBox } from './boxes'
import { blockHash } from './boxCode'

export type FoundBlock = { start: number; end: number; text: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The block for `id`: its offsets (both marker lines and the final line break included). */
export function findBlock(text: string, id: string): FoundBlock | 'missing' | 'broken' {
  const startRe = new RegExp(`^# forge:box ${escape(id)}(?:\\s|$)`)
  const endRe = new RegExp(`^# forge:end ${escape(id)}\\s*$`)
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  while (at <= text.length) {
    const nl = text.indexOf('\n', at)
    const lineEnd = nl < 0 ? text.length : nl + 1
    const line = text.slice(at, nl < 0 ? text.length : nl).replace(/\r$/, '')
    if (startRe.test(line)) starts.push(at)
    if (endRe.test(line)) ends.push(lineEnd)
    if (nl < 0) break
    at = lineEnd
  }
  if (!starts.length && !ends.length) return 'missing'
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return 'broken'
  return { start: starts[0], end: ends[0], text: text.slice(starts[0], ends[0]) }
}

/** How the box's code looks now: as Forge wrote it, edited by hand, gone, or with damaged markers. */
export function blockState(text: string, box: ApiBox): 'ok' | 'edited' | 'missing' | 'broken' {
  const f = findBlock(text, box.id)
  if (f === 'missing' || f === 'broken') return f
  return blockHash(f.text) === box.hash ? 'ok' : 'edited'
}

/** The block with the file's line endings. */
export function withEol(block: string, sample: string): string {
  return sample.includes('\r\n') ? block.replace(/\r?\n/g, '\r\n') : block
}

export function replaceBlock(text: string, id: string, block: string): string {
  const f = findBlock(text, id)
  if (f === 'missing' || f === 'broken') throw new Error(`The code block for ${id} is ${f}.`)
  return text.slice(0, f.start) + withEol(block, text) + text.slice(f.end)
}

/** Add the block at the end of the file, after one blank line. */
export function insertBlock(text: string, block: string): string {
  if (!text) return block
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return (text.endsWith('\n') ? text : text + eol) + eol + withEol(block, text)
}

/** Remove the block (and, at the end of the file, the blank line insertBlock put before it). */
export function removeBlock(text: string, id: string): string {
  const f = findBlock(text, id)
  if (f === 'missing' || f === 'broken') return text
  let start = f.start
  if (f.end === text.length) {
    const head = text.slice(0, start)
    const blank = /(\r?\n)(\r?\n)$/.exec(head)
    if (blank) start -= blank[2].length
  }
  return text.slice(0, start) + text.slice(f.end)
}
