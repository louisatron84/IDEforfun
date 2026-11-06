/**
 * Guard tests for the Forge look (docs/superpowers/specs/2026-11-06-forge-design.md, Part 1).
 * They read the renderer's CSS files: colours live only in theme.css, both
 * themes define the same tokens, text is readable, and the shape rules hold.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const theme = read('src/renderer/theme.css')
const styles = read('src/renderer/styles.css')

/** `--name: value;` pairs of the first block whose selector is exactly `selector`. */
function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return {}
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const molten = tokens(theme, ':root')
const plain = tokens(theme, ':root[data-theme="plain"]')

/** CSS rules (selector + body), with comments and @media wrappers flattened. */
export function cssRules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { selector: string; body: string }[] = []
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim().replace(/^@media[^{]*\{\s*/, ''), body: m[2] })
  return out
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('Forge colour tokens', () => {
  it('Plain defines every token Molten defines', () => {
    expect(Object.keys(molten).length).toBeGreaterThan(20)
    expect(Object.keys(plain).sort()).toEqual(Object.keys(molten).sort())
  })

  it.each(['molten', 'plain'])('%s: all text colours pass WCAG AA on bg and panel', (name) => {
    const t = name === 'molten' ? molten : plain
    const text = ['--fg', '--fg-muted', '--err', '--warn', '--ok', '--info', ...Object.keys(t).filter((k) => k.startsWith('--tok-'))]
    for (const k of text) {
      for (const bg of ['--bg', '--bg-panel']) expect(contrast(t[k], t[bg]), `${k} ${t[k]} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(t['--on-heat'], t['--heat-3'])).toBeGreaterThanOrEqual(4.5)
  })

  it('Molten uses the spec values', () => {
    expect(molten).toMatchObject({
      '--bg': '#120c0a', '--bg-panel': '#170e0b', '--raised': '#1d120e', '--border': '#3a2017', '--line-strong': '#5a3322',
      '--fg': '#f3e2d4', '--fg-muted': '#a08576', '--heat-1': '#ffcf5c', '--heat-2': '#ffb02e', '--heat-3': '#ff6a1a', '--heat-4': '#e8431d',
      '--tok-keyword': '#ff6a3d', '--tok-function': '#ffc857', '--tok-string': '#e8a87c', '--tok-comment': '#a0806f', '--tok-decorator': '#d9a35f',
      '--radius': '0'
    })
  })

  it('styles.css has no colour literals (all colours come from theme.css)', () => {
    expect(styles.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([])
  })
})
