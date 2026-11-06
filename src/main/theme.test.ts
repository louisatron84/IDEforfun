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

describe('Forge fonts', () => {
  it('Space Grotesk for the interface and JetBrains Mono for code, in both themes', () => {
    for (const t of [molten, plain]) {
      expect(t['--font-ui']).toMatch(/^'Space Grotesk'/)
      expect(t['--font-code']).toMatch(/^'JetBrains Mono'/)
    }
  })

  it('are bundled with pinned versions', () => {
    const deps = JSON.parse(read('package.json')).dependencies as Record<string, string>
    for (const name of ['@fontsource/space-grotesk', '@fontsource/jetbrains-mono']) expect(deps[name]).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('Smithy schematic shapes', () => {
  const rules = cssRules(styles)

  it('square corners: every border-radius is var(--radius) or 50%', () => {
    for (const r of rules) {
      for (const v of r.body.matchAll(/border-radius:\s*([^;]+)/g)) expect(['var(--radius)', '50%'], r.selector).toContain(v[1].trim())
    }
  })

  it('gradients only on the wordmark and the graph grid, never on clickable things', () => {
    const withGradient = rules.filter((r) => /gradient\(/.test(r.body)).map((r) => r.selector)
    expect(withGradient.length).toBeGreaterThan(0)
    // .editor .squiggle uses gradients only to draw the wavy error underline (one colour, not clickable).
    // .dock.editing-layout: the blueprint grid shown across the window in Edit Layout mode (spec, Part 2).
    for (const s of withGradient) expect(s).toMatch(/^(\.wordmark|\.graph-canvas|\.editor \.squiggle|\.dock\.editing-layout)$/)
  })

  it('reduced motion turns off transitions and animations', () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important[\s\S]*animation: none !important/)
  })

  it('primary buttons are solid, angled and use the heat colour', () => {
    const btn = rules.find((r) => r.selector.split(',').map((s) => s.trim()).includes('#toolbar button'))!
    expect(btn.body).toMatch(/background: var\(--heat-3\)/)
    expect(btn.body).toMatch(/clip-path: polygon\(6px 0/)
  })

  it('the toolbar starts with the Forge wordmark', () => {
    expect(read('src/renderer/index.html')).toMatch(/<header id="toolbar">\s*<span class="wordmark">Forge<\/span>/)
  })
})

describe('review fixes', () => {
  const rules = cssRules(styles)
  /** The body of the last rule whose selector list contains `selector` (later rules win). */
  const last = (selector: string) => [...rules].reverse().find((r) => r.selector.split(',').map((x) => x.trim()).includes(selector))?.body ?? ''

  it('graph nodes stand out from the canvas: raised fill, strong outline', () => {
    expect(last('.gnode rect:first-of-type')).toMatch(/fill: var\(--raised\)/)
    expect(last('.gnode rect:first-of-type')).toMatch(/stroke: var\(--line-strong\)/)
    expect(contrast(molten['--line-strong'], molten['--bg'])).toBeGreaterThanOrEqual(1.5)
  })

  it('angled buttons show keyboard focus inside their clip', () => {
    for (const sel of ['#toolbar button:focus-visible', '.git-primary:focus-visible']) expect(last(sel), sel).toMatch(/box-shadow: inset 0 0 0 2px var\(--fg\)/)
  })

  it('graph errors and import cycles use the error colour (not heat, which is white in Plain)', () => {
    expect(last('.gnode.err .glabel')).toMatch(/fill: var\(--err\)/)
    expect(last('.arrow.cyc')).toMatch(/fill: var\(--err\)/)
    expect(last('.gedge.cyc')).toMatch(/stroke: var\(--err\)/)
    expect(plain['--err']).not.toBe(plain['--fg'])
  })

  it('breakpoints stay round dots', () => {
    expect(last('.editor .gutter-lines > div::before')).toMatch(/border-radius: 50%/)
  })
})

