/**
 * Our own editor, step one: a read-only text view.
 *
 * It renders a line-number gutter next to the file's text. Editing (cursor,
 * typing, selection) comes in v0.2 on top of a TextBuffer model; this view
 * will then render from that buffer instead of a plain string.
 */
export class TextView {
  private readonly root: HTMLElement
  private readonly gutter: HTMLPreElement
  private readonly content: HTMLPreElement

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.gutter = document.createElement('pre')
    this.gutter.className = 'gutter'
    this.content = document.createElement('pre')
    this.content.className = 'content'
    container.replaceChildren(this.root)
    this.showPlaceholder('Open a folder and pick a file')
  }

  setText(text: string): void {
    const lines = splitLines(text)
    this.gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n')
    // textContent (not innerHTML) so file contents are never parsed as HTML.
    this.content.textContent = lines.join('\n')
    this.root.className = 'text-view'
    this.root.replaceChildren(this.gutter, this.content)
    this.root.scrollTo(0, 0)
  }

  showPlaceholder(message: string): void {
    this.root.className = 'text-view empty'
    this.root.textContent = message
  }
}

/** Split on \n, \r\n or \r. An empty file still has one (empty) line. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}
