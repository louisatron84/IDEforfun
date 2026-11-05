/**
 * Turn the Markdown that language servers send for hovers into simple
 * tooltip sections: code blocks (shown monospace) and plain text. We don't
 * render full Markdown; this is enough for signatures and docstrings, and
 * everything ends up as text (never HTML).
 */
import type { TooltipSection } from '../tooltip'

export function hoverSections(markdown: string): TooltipSection[] {
  const sections: TooltipSection[] = []
  const pushText = (raw: string) => {
    const text = raw
      .split('\n')
      .filter((l) => !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) // horizontal rules
      .join('\n')
      .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1') // markdown escapes
      .trim()
    if (text) sections.push({ text })
  }
  const fence = /```[\w-]*\n([\s\S]*?)```/g
  let last = 0
  for (const m of markdown.matchAll(fence)) {
    pushText(markdown.slice(last, m.index))
    const code = m[1].trim()
    if (code) sections.push({ kind: 'code', text: code })
    last = m.index! + m[0].length
  }
  pushText(markdown.slice(last))
  return sections
}
