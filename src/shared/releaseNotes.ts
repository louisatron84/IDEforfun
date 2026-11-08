/**
 * Release notes on the Welcome page ("What's new in Forge X", after an
 * update). The notes are the GitHub release's Markdown; only the little of it
 * they use is understood (headings, paragraphs, "- " lists, **bold**, `code`),
 * and everything becomes text, never HTML.
 */

export interface Span {
  text: string
  bold?: boolean
  code?: boolean
}

export type NoteBlock =
  | { kind: 'h'; text: Span[] }
  | { kind: 'p'; text: Span[] }
  | { kind: 'ul'; items: Span[][] }

/** **bold** and `code` within a line. */
export function spans(line: string): Span[] {
  const out: Span[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let at = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) })
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], code: true })
    at = m.index + m[0].length
  }
  if (at < line.length) out.push({ text: line.slice(at) })
  return out
}

export function noteBlocks(md: string): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let para: string[] = []
  let list: Span[][] | null = null
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: spans(para.join(' ')) })
    para = []
    if (list) blocks.push({ kind: 'ul', items: list })
    list = null
  }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'h', text: spans(heading[1]) })
      continue
    }
    const item = /^[-*]\s+(.*)$/.exec(line)
    if (item) {
      if (para.length) {
        blocks.push({ kind: 'p', text: spans(para.join(' ')) })
        para = []
      }
      ;(list ??= []).push(spans(item[1]))
      continue
    }
    if (list) flush()
    para.push(line)
  }
  flush()
  return blocks
}

/** Is `latest` newer than `current`? (1.2.10 > 1.2.9; a leading v is ignored; pre-releases are older than the release.) */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/i, '').split('-', 2)
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null }
  }
  const a = parse(current)
  const b = parse(latest)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const x = a.nums[i] ?? 0
    const y = b.nums[i] ?? 0
    if (x !== y) return y > x
  }
  if (a.pre && !b.pre) return true
  if (!a.pre && b.pre) return false
  return !!a.pre && !!b.pre && b.pre > a.pre
}

/** After an update (not a first install, not a downgrade): the first start of a newer version. */
export function shouldShowWhatsNew(lastRun: string | null, current: string): boolean {
  return lastRun !== null && isNewer(lastRun, current)
}
