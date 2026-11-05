import { describe, expect, it } from 'vitest'
import { TextBuffer } from './textBuffer'
import { Highlighter } from './highlighter'

const types = (h: Highlighter, line: number) => h.tokensFor(line).map((t) => t.type)

describe('Highlighter', () => {
  it('colors lines inside a docstring as string, using state from earlier lines', () => {
    const b = new TextBuffer('def f():\n    """Doc\n    more\n    """\n    return 1')
    const h = new Highlighter(b)
    expect(types(h, 2)).toEqual(['string'])
    expect(types(h, 4)).toEqual(['keyword', 'number'])
  })

  it('re-colors later lines when an edit opens a docstring', () => {
    const b = new TextBuffer('x = 1\ny = 2\nz = 3')
    const h = new Highlighter(b)
    expect(types(h, 2)).toEqual(['number']) // computes and caches states for lines 0..2

    b.insert({ line: 0, col: 0 }, '"""')
    expect(types(h, 1)).toEqual(['string'])
    expect(types(h, 2)).toEqual(['string'])

    b.delete({ line: 0, col: 0 }, { line: 0, col: 3 })
    expect(types(h, 2)).toEqual(['number'])
  })

  it('only tokenizes as far as it needs to', () => {
    const b = new TextBuffer(Array.from({ length: 10_000 }, (_, i) => `x${i} = ${i}`).join('\n'))
    const h = new Highlighter(b)
    h.tokensFor(5)
    expect(h.cachedLines).toBeLessThan(10)
  })
})

describe('Highlighter: cheap access for the minimap', () => {
  it('only gives tokens for lines whose state is cached, and warms up on request', () => {
    const b = new TextBuffer(Array.from({ length: 1000 }, (_, i) => `x${i} = "${i}"`).join('\n'))
    const h = new Highlighter(b)
    expect(h.tokensIfCached(0)).not.toBeNull()
    expect(h.tokensIfCached(900)).toBeNull()
    while (h.warmUp(50, 900)) { /* keep going */ }
    expect(h.tokensIfCached(900)?.length).toBeGreaterThan(0)
    // An edit near the top forgets the states below it again.
    b.insert({ line: 1, col: 0 }, '# ')
    expect(h.tokensIfCached(900)).toBeNull()
  })
})
