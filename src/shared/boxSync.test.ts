import { describe, expect, it } from 'vitest'
import { newApiBox } from './boxes'
import { blockHash } from './boxCode'
import { blockState, findBlock, insertBlock, removeBlock, replaceBlock, withEol } from './boxSync'

const block = (id: string, body = 'x = 1') => `# forge:box ${id} (generated, edit in Forge or here)\n${body}\n# forge:end ${id}\n`
const before = 'import os\n\n'
const after = '\nprint("after")\n'

describe('findBlock', () => {
  it('finds the whole block, marker lines and final line break included', () => {
    const text = before + block('gh-1') + after
    const f = findBlock(text, 'gh-1')
    expect(f).toEqual({ start: before.length, end: before.length + block('gh-1').length, text: block('gh-1') })
  })

  it('works on CRLF files and at the very end without a newline', () => {
    const crlf = (before + block('gh-1') + after).replace(/\n/g, '\r\n')
    const f = findBlock(crlf, 'gh-1')
    expect(f !== 'missing' && f !== 'broken' && f.text).toBe(block('gh-1').replace(/\n/g, '\r\n'))
    const tail = before + block('gh-1').trimEnd()
    const g = findBlock(tail, 'gh-1')
    expect(g !== 'missing' && g !== 'broken' && g.end).toBe(tail.length)
  })

  it('missing, or broken markers', () => {
    expect(findBlock(before, 'gh-1')).toBe('missing')
    expect(findBlock(before + block('gh-1') + block('gh-1'), 'gh-1')).toBe('broken')
    expect(findBlock(before + '# forge:box gh-1 (generated)\nx = 1\n', 'gh-1')).toBe('broken')
    expect(findBlock('# forge:end gh-1\n', 'gh-1')).toBe('broken')
    expect(findBlock(block('gh-1').split('\n').reverse().join('\n'), 'gh-1')).toBe('broken')
  })

  it('ids are matched exactly', () => {
    expect(findBlock(block('gh-10'), 'gh-1')).toBe('missing')
    expect(findBlock(block('a.b'), 'axb')).toBe('missing')
  })
})

describe('blockState', () => {
  it('ok, edited by hand, missing', () => {
    const box = newApiBox([], 'GH')
    const b = block(box.id)
    box.hash = blockHash(b)
    expect(blockState(before + b, box)).toBe('ok')
    expect(blockState((before + b).replace(/\n/g, '\r\n'), box)).toBe('ok')
    expect(blockState(before + b.replace('x = 1', 'x = 2'), box)).toBe('edited')
    expect(blockState(before, box)).toBe('missing')
    expect(blockState(before + b + b, box)).toBe('broken')
  })
})

describe('editing the file', () => {
  it('replaceBlock leaves everything else byte-identical', () => {
    const text = (before + block('gh-1') + after).replace(/\n/g, '\r\n')
    const out = replaceBlock(text, 'gh-1', block('gh-1', 'y = 2'))
    expect(out).toBe((before + block('gh-1', 'y = 2') + after).replace(/\n/g, '\r\n'))
  })

  it('insertBlock appends with a blank line between', () => {
    expect(insertBlock('', block('a'))).toBe(block('a'))
    expect(insertBlock('x = 0\n', block('a'))).toBe('x = 0\n\n' + block('a'))
    expect(insertBlock('x = 0', block('a'))).toBe('x = 0\n\n' + block('a'))
    expect(insertBlock('x = 0\r\n', block('a'))).toBe('x = 0\r\n\r\n' + block('a').replace(/\n/g, '\r\n'))
  })

  it('removeBlock undoes insertBlock', () => {
    for (const t of ['x = 0\n', '', 'x = 0\r\n']) expect(removeBlock(insertBlock(t, block('a')), 'a')).toBe(t)
    expect(removeBlock(before + block('a') + after, 'a')).toBe(before + after)
  })

  it('withEol follows the file', () => {
    expect(withEol('a\nb\n', 'x\r\n')).toBe('a\r\nb\r\n')
    expect(withEol('a\nb\n', 'x\n')).toBe('a\nb\n')
  })
})
