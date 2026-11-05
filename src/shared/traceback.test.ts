import { describe, expect, it } from 'vitest'
import { findFileLinks, stripAnsi } from './traceback'

describe('findFileLinks', () => {
  it('finds Python traceback locations', () => {
    const text = 'Traceback (most recent call last):\n  File "C:\\proj\\app.py", line 12, in <module>\n    main()\n'
    const [link] = findFileLinks(text)
    expect(link.path).toBe('C:\\proj\\app.py')
    expect(link.line).toBe(12)
    expect(text.slice(link.start, link.end)).toBe('File "C:\\proj\\app.py", line 12')
  })
  it('finds several links and unix paths', () => {
    const text = '  File "/a/b.py", line 1, in f\n  File "/a/c.py", line 200, in g\n'
    expect(findFileLinks(text).map((l) => [l.path, l.line])).toEqual([['/a/b.py', 1], ['/a/c.py', 200]])
  })
  it('ignores Python internals like <frozen ...> and <string>', () => {
    expect(findFileLinks('  File "<frozen runpy>", line 198, in _run\n')).toEqual([])
  })
})

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain \x1b[1;32mbold\x1b[m')).toBe('red plain bold')
  })
})
