import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScan } from './projectScan'
import { buildGraph, hostOf, isTestPath, stronglyConnected, type ProjectGraph, type RawScan } from '../shared/projectGraph'

/** A python on PATH, or null (then the tests that need it are skipped). */
function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'import ast'], { stdio: 'ignore', timeout: 20000 })
      return cmd
    } catch {
      // try the next
    }
  }
  return null
}
const python = findPython()

const FILES: Record<string, string> = {
  'app/__init__.py': '',
  'app/main.py': [
    'import os',
    'from app.service import fetch_user',
    'from .api import routes',
    'KEY = os.environ["API_KEY"]',
    'def main():',
    '    print(fetch_user(1))',
    'if __name__ == "__main__":',
    '    main()'
  ].join('\n'),
  'app/service.py': [
    'import requests',
    'import os',
    'from app import util',
    'BASE = os.getenv("BASE_URL", "https://api.example.com")',
    'class Client:',
    '    def get(self, id):',
    '        return self._call(id)',
    '    def _call(self, id):',
    '        return requests.get(f"https://api.github.com/users/{id}").json()',
    'def fetch_user(id):',
    '    return Client().get(id)',
    'def never_used():',
    '    util.helper()',
    'def recursive(n):',
    '    return recursive(n - 1) if n else 0'
  ].join('\n'),
  'app/util.py': ['from app import service', 'def helper():', '    return service.BASE'].join('\n'),
  'app/api/__init__.py': '',
  'app/api/routes.py': [
    'from fastapi import APIRouter',
    'import httpx',
    'router = APIRouter()',
    '@router.get("/users/{id}")',
    'async def read_user(id: int):',
    '    async with httpx.AsyncClient() as c:',
    '        await c.get("https://example.org/x")',
    '    return httpx.post("https://hooks.slack.com/x")'
  ].join('\n'),
  'app/broken.py': 'def oops(:\n',
  'tests/test_service.py': 'from app.service import fetch_user\ndef test_it():\n    assert fetch_user(1)\n',
  '.venv/lib/skip.py': 'x = 1\n'
}

describe.skipIf(!python)('project scan (real Python)', () => {
  let dir: string
  let graph: ProjectGraph
  let scan: RawScan
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ideforfun-scan-'))
    for (const [rel, text] of Object.entries(FILES)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    const res = await runScan(python!, dir)
    expect(res.error).toBeUndefined()
    scan = res.scan!
    graph = buildGraph(scan)
  }, 60000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('finds every module (skipping virtual environments), with packages and tests marked', () => {
    expect(graph.modules.map((m) => m.id).sort()).toEqual(['app', 'app.api', 'app.api.routes', 'app.broken', 'app.main', 'app.service', 'app.util', 'tests.test_service'])
    expect(graph.modules.find((m) => m.id === 'app')!.isPackage).toBe(true)
    expect(graph.modules.find((m) => m.id === 'tests.test_service')!.isTest).toBe(true)
    expect(graph.modules.find((m) => m.id === 'app.main')!.isEntry).toBe(true)
  })

  it('resolves absolute, relative and submodule imports; the rest are external packages', () => {
    const edges = graph.imports.map((e) => `${e.from} -> ${e.to}`).sort()
    expect(edges).toEqual([
      'app.main -> app.api.routes',
      'app.main -> app.service',
      'app.service -> app.util',
      'app.util -> app.service',
      'tests.test_service -> app.service'
    ])
    expect(graph.externals.map((x) => x.name)).toEqual(['fastapi', 'httpx', 'os', 'requests'])
  })

  it('finds the import cycle and marks its edges', () => {
    expect(graph.cycles).toEqual([['app.service', 'app.util']])
    expect(graph.imports.filter((e) => e.cyclic).map((e) => e.from).sort()).toEqual(['app.service', 'app.util'])
  })

  it('links calls to the functions they reach', () => {
    const calls = graph.calls.map((c) => `${c.from} -> ${c.to}`).sort()
    expect(calls).toEqual(expect.arrayContaining([
      'module:app.main -> app.main:main',
      'app.main:main -> app.service:fetch_user',
      'app.service:fetch_user -> app.service:Client',
      'app.service:fetch_user -> app.service:Client.get',
      'app.service:Client.get -> app.service:Client._call',
      'app.service:never_used -> app.util:helper',
      'tests.test_service:test_it -> app.service:fetch_user'
    ]))
    // Recursion isn't an edge to itself.
    expect(calls.some((c) => c.includes('recursive -> '))).toBe(false)
  })

  it('reports functions nothing uses (not tests, not routes, not recursion)', () => {
    expect(graph.unused.map((s) => s.id).sort()).toEqual(['app.service:never_used', 'app.service:recursive'])
  })

  it('finds routes, HTTP calls with their hosts, and environment variables', () => {
    expect(graph.routes).toMatchObject([{ methods: ['GET'], path: '/users/{id}', func: 'read_user', module: 'app.api.routes', framework: 'fastapi' }])
    expect(graph.http.map((h) => `${h.library} ${h.method} ${h.host} in ${h.module}:${h.func}`).sort()).toEqual([
      'httpx GET example.org in app.api.routes:read_user',
      'httpx POST hooks.slack.com in app.api.routes:read_user',
      'requests GET api.github.com in app.service:Client._call'
    ])
    expect(graph.env.map((e) => e.name)).toEqual(['API_KEY', 'BASE_URL'])
    expect(graph.env[1].uses[0]).toMatchObject({ module: 'app.service', default: true })
  })

  it('reports files it could not read instead of failing', () => {
    expect(graph.errors).toMatchObject([{ module: 'app.broken', path: 'app/broken.py' }])
    expect(graph.errors[0].error).toMatch(/SyntaxError/)
  })
})

describe('project graph helpers', () => {
  it('hostOf', () => {
    expect(hostOf('https://api.github.com/users/{…}')).toBe('api.github.com')
    expect(hostOf('http://user:pw@Example.ORG:8080/x')).toBe('example.org:8080')
    expect(hostOf('/relative')).toBeNull()
    expect(hostOf(null)).toBeNull()
  })

  it('isTestPath', () => {
    expect(isTestPath('tests/test_a.py')).toBe(true)
    expect(isTestPath('pkg/a_test.py')).toBe(true)
    expect(isTestPath('conftest.py')).toBe(true)
    expect(isTestPath('pkg/testing_utils.py')).toBe(false)
  })

  it('stronglyConnected finds loops, including long ones', () => {
    const nodes = ['a', 'b', 'c', 'd']
    const comps = stronglyConnected(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'c', to: 'd' }])
    expect(comps.filter((c) => c.length > 1)).toEqual([['a', 'b', 'c']])
    const many = Array.from({ length: 20000 }, (_, i) => `m${i}`)
    const chain = many.map((m, i) => ({ from: m, to: many[(i + 1) % many.length] }))
    expect(stronglyConnected(many, chain)[0]).toHaveLength(20000)
  })
})
