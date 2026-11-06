import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScan } from './projectScan'
import { readSpec } from '../shared/openapi'
import { generateClient } from '../shared/openapiCode'
import { buildGraph, describeUnreachable, hostOf, isTestPath, stronglyConnected, type ProjectGraph, type RawScan } from '../shared/projectGraph'

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
  'tests/test_dead.py': [
    'def early(x):',
    '    return x',
    '    print("never")',
    'def loop():',
    '    for i in range(3):',
    '        continue',
    '        i += 1',
    'def both(x):',
    '    if x:',
    '        return 1',
    '    else:',
    '        raise ValueError(x)',
    '    x += 1',
    '    x += 2',
    'def guarded():',
    '    if False:',
    '        print("off")',
    '    try:',
    '        return 1',
    '    except ValueError:',
    '        pass',
    '    print("reachable: the handler falls through")',
    '    while True:',
    '        if guarded():',
    '            break',
    '    with open("x") as f:',
    '        return f',
    '    print("reachable: a context manager can swallow the error")',
    'def ok(x):',
    '    if x:',
    '        return 1',
    '    return 2'
  ].join('\n'),
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
    expect(graph.modules.map((m) => m.id).sort()).toEqual(['app', 'app.api', 'app.api.routes', 'app.broken', 'app.main', 'app.service', 'app.util', 'tests.test_dead', 'tests.test_service'])
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

  it('finds code that can never run (after return/raise/break/continue, branches that all stop, constant conditions)', () => {
    expect(graph.unreachable.map((u) => `${u.module}:${u.line}-${u.endLine} ${u.func} ${u.reason}`)).toEqual([
      'tests.test_dead:3-3 early return',
      'tests.test_dead:7-7 loop continue',
      'tests.test_dead:13-14 both branches',
      'tests.test_dead:17-17 guarded constant'
    ])
    expect(describeUnreachable(graph.unreachable[0])).toBe('line 3, after a return')
    expect(describeUnreachable(graph.unreachable[2])).toBe('lines 13–14, every branch above it stops')
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

describe.skipIf(!python)('project scan: generated clients and base addresses (real Python)', () => {
  let dir: string
  let graph: ProjectGraph
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forge-scan-gen-'))
    const spec = readSpec({
      swagger: '2.0', info: { title: 'Café Shop', version: '1' }, host: 'shop.example.com', basePath: '/api',
      paths: { '/items': { get: { operationId: 'listItems', responses: { 200: { description: 'ok' } } } } }
    })
    const code = generateClient(spec)
    writeFileSync(join(dir, 'shop_client.py'), code)
    writeFileSync(join(dir, 'edited_client.py'), code.replace(/\n/g, '\r\n') + '# my change\r\n')
    writeFileSync(join(dir, 'raw.py'), 'import urllib.request\nBASE_URL = "https://data.example.org/v2"\ndef get():\n    return urllib.request.urlopen(BASE_URL + "/x")\n')
    const res = await runScan(python!, dir)
    graph = buildGraph(res.scan!)
  }, 60000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('marks clients Forge generated, and whether they were edited since (hashes agree with TypeScript, line endings ignored)', () => {
    const mod = (id: string) => graph.modules.find((m) => m.id === id)!
    expect(mod('shop_client').generated).toEqual({ kind: 'openapi', slug: 'caf_shop', edited: false })
    expect(mod('edited_client').generated).toEqual({ kind: 'openapi', slug: 'caf_shop', edited: true })
    expect(mod('raw').generated).toBeUndefined()
  })

  it('urllib calls whose address comes from the module\'s BASE_URL reach that host', () => {
    expect(graph.http.filter((h) => h.module === 'raw').map((h) => `${h.library} ${h.method} ${h.host}`)).toEqual(['urllib HTTP data.example.org'])
    expect(graph.http.filter((h) => h.module === 'shop_client').map((h) => h.host)).toEqual(['shop.example.com'])
  })
})
