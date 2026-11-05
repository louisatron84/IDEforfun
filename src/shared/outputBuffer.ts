/**
 * Keeping program output cheap. A program can print far faster than a window
 * can draw (200k lines in under a second), so output is collected into
 * batches, and when too much piles up only the newest part is kept, with a
 * note saying how many lines were skipped.
 */

export type Stream = 'stdout' | 'stderr'

export interface OutputPiece {
  stream: Stream
  text: string
}

/** Number of line breaks in `text`. */
export function countLines(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** The last `max` lines of `text`, and how many lines were cut off. */
export function lastLines(text: string, max: number): { text: string; cut: number } {
  const total = countLines(text)
  if (total <= max) return { text, cut: 0 }
  let i = text.length
  // Walk back over `max` line breaks (the text may end without one).
  let seen = text.endsWith('\n') ? -1 : 0
  while (i > 0 && seen < max) {
    i = text.lastIndexOf('\n', i - 1)
    if (i === -1) return { text, cut: 0 }
    seen++
  }
  return { text: text.slice(i + 1), cut: countLines(text.slice(0, i + 1)) }
}

/**
 * Collects pieces of output, merging neighbours from the same stream, and
 * keeps at most `maxChars` (dropping the oldest whole lines first).
 */
export class OutputQueue {
  private pieces: OutputPiece[] = []
  private chars = 0
  /** Lines dropped since the last take(). */
  private dropped = 0

  constructor(private readonly maxChars: number) {}

  get size(): number {
    return this.chars
  }

  get isEmpty(): boolean {
    return this.pieces.length === 0 && this.dropped === 0
  }

  push(stream: Stream, text: string): void {
    if (!text) return
    const last = this.pieces[this.pieces.length - 1]
    if (last && last.stream === stream) last.text += text
    else this.pieces.push({ stream, text })
    this.chars += text.length
    if (this.chars > this.maxChars) this.trim()
  }

  /** Drop the oldest output (whole lines) until it fits. */
  private trim(): void {
    // Aim a bit lower than the limit so we don't trim on every push.
    const target = Math.floor(this.maxChars * 0.75)
    while (this.chars > target && this.pieces.length) {
      const first = this.pieces[0]
      const excess = this.chars - target
      if (first.text.length <= excess) {
        this.dropped += countLines(first.text)
        this.chars -= first.text.length
        this.pieces.shift()
        continue
      }
      // Cut inside this piece, at a line break so no line is shown half.
      let cut = first.text.indexOf('\n', excess - 1)
      cut = cut === -1 ? first.text.length : cut + 1
      this.dropped += countLines(first.text.slice(0, cut))
      this.chars -= cut
      first.text = first.text.slice(cut)
      if (!first.text) this.pieces.shift()
    }
  }

  /** Everything collected (and how many lines were dropped), emptying the queue. */
  take(): { pieces: OutputPiece[]; dropped: number } {
    const out = { pieces: this.pieces, dropped: this.dropped }
    this.pieces = []
    this.chars = 0
    this.dropped = 0
    return out
  }

  clear(): void {
    this.take()
  }
}

export function skippedNote(lines: number): string {
  return `[… ${lines.toLocaleString('en-US')} line${lines === 1 ? '' : 's'} of output skipped: the program printed faster than it can be shown …]\n`
}
