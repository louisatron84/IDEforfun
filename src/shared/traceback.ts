/** Helpers for showing program output: clickable traceback locations and ANSI stripping. */

export interface FileLink {
  start: number
  end: number
  path: string
  line: number
}

// Python traceback lines look like:   File "C:\proj\app.py", line 12, in <module>
const TRACEBACK = /File "([^"<>]+)", line (\d+)/g

export function findFileLinks(text: string): FileLink[] {
  const links: FileLink[] = []
  for (const m of text.matchAll(TRACEBACK)) {
    links.push({ start: m.index!, end: m.index! + m[0].length, path: m[1], line: Number(m[2]) })
  }
  return links
}

/** Remove terminal color/style codes (the output panel shows plain text). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}
