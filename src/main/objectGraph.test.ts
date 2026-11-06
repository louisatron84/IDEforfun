import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { OBJECT_HELPER, objectGraphExpression, parseObjectGraph, unreprString } from '../shared/objectGraph'

function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'pass'], { stdio: 'ignore', timeout: 20000 })
      return cmd
    } catch {
      // try the next
    }
  }
  return null
}
const python = findPython()

describe('unreprString', () => {
  it('undoes Python string reprs', () => {
    expect(unreprString(`'{"a": "it\\'s"}'`)).toBe(`{"a": "it's"}`)
    expect(unreprString(`'a\\\\b \\n \\x41 \\u00e9'`)).toBe('a\\b \n A é')
    expect(unreprString('"plain"')).toBe('plain')
    expect(unreprString('{"no": "quotes"}')).toBe('{"no": "quotes"}')
  })
})

describe('parseObjectGraph', () => {
  it('keeps only well-formed parts', () => {
    const g = parseObjectGraph(JSON.stringify({
      roots: [['x', '1'], ['ghost', '9']],
      nodes: [{ id: '1', type: 'Point', fields: [['x', '1'], ['bad']], more: 0 }, { nope: true }],
      edges: [['1', '1', 'self'], ['1', '9', 'missing']]
    }))
    expect(g).toEqual({ roots: [['x', '1']], nodes: [{ id: '1', type: 'Point', fields: [['x', '1']], more: 0 }], edges: [['1', '1', 'self']] })
    expect(parseObjectGraph('not json')).toBeNull()
  })
})

describe.skipIf(!python)('the object helper (real Python)', () => {
  const run = (setup: string): ReturnType<typeof parseObjectGraph> => {
    // Evaluate the same expression the debugger would, with these locals.
    const code = `${setup}\nprint(eval(${JSON.stringify(objectGraphExpression())}))`
    return parseObjectGraph(execFileSync(python!, ['-c', code], { encoding: 'utf8' }))
  }

  it('finds objects, their simple fields, and references (shared objects once)', () => {
    const g = run([
      'class Node:',
      '    def __init__(self, v, nxt=None):',
      '        self.value = v',
      '        self.next = nxt',
      'tail = Node(2)',
      'head = Node(1, tail)',
      'items = [head, tail]',
      'count = 3'
    ].join('\n'))!
    expect(g.roots.map((r) => r[0]).sort()).toEqual(['head', 'items', 'tail'])
    const byId = new Map(g.nodes.map((n) => [n.id, n]))
    const head = byId.get(g.roots.find((r) => r[0] === 'head')![1])!
    const tail = byId.get(g.roots.find((r) => r[0] === 'tail')![1])!
    expect(head.type).toBe('Node')
    expect(head.fields).toContainEqual(['value', '1'])
    expect(g.edges).toContainEqual([head.id, tail.id, 'next'])
    const list = byId.get(g.roots.find((r) => r[0] === 'items')![1])!
    expect(list.len).toBe(2)
    expect(g.edges).toContainEqual([list.id, head.id, '[0]'])
    expect(g.nodes.filter((n) => n.type === 'Node')).toHaveLength(2)
  })

  it('stops at the size limit and survives cycles', () => {
    const g = run('a = []\na.append(a)\nbig = [[i] for i in range(100)]')!
    expect(g.nodes.length).toBeLessThanOrEqual(40)
    const a = g.roots.find((r) => r[0] === 'a')![1]
    expect(g.edges).toContainEqual([a, a, '[0]'])
  })

  it('the helper is plain Python (no syntax errors)', () => {
    expect(() => execFileSync(python!, ['-c', OBJECT_HELPER + '\nprint(forge_objects({}))'], { encoding: 'utf8' })).not.toThrow()
  })
})
