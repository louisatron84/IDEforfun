/**
 * The run tracer with a real Python (skipped if there is none): the program
 * behaves exactly as untraced, and Forge gets "where it's at" updates.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openTraceServer, traceCommand, traceEnv } from './runTrace'

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
  'pkg/__init__.py': '',
  'pkg/b.py': [
    'def work(n):',
    '    return n * 2',
    '',
    'if __name__ == "__main__":',
    '    print("b as main", work(4))'
  ].join('\n'),
  'main.py': [
    'import sys',
    'from pkg.b import work',
    '',
    'def start():',
    '    total = 0',
    '    for i in range(5):',
    '        total += work(i)',
    '    return total',
    '',
    'if __name__ == "__main__":',
    '    print("argv", sys.argv[1:])',
    '    print("path0 is script dir", sys.path[0] == __import__("os").path.dirname(__import__("os").path.abspath(__file__)))',
    '    print("total", start())'
  ].join('\n'),
  'fail.py': ['def boom():', '    raise ValueError("bad")', '', 'boom()'].join('\n'),
  'exit3.py': 'import sys\nsys.exit(3)\n',
  'net.py': [
    'import json, socket, sys, urllib.request, urllib.error',
    'port = int(sys.argv[1])',
    'base = "http://127.0.0.1:%d" % port',
    '',
    'def fetch_users():',
    '    req = urllib.request.Request(base + "/users?page=2&api_key=SECRET1", headers={"Authorization": "Bearer SECRET2"})',
    '    with urllib.request.urlopen(req) as r:',
    '        return json.loads(r.read())',
    '',
    'def login():',
    '    body = json.dumps({"name": "ann", "password": "SECRET3"}).encode()',
    '    req = urllib.request.Request(base + "/login", data=body, headers={"Content-Type": "application/json"})',
    '    return urllib.request.urlopen(req).status',
    '',
    'def missing():',
    '    try:',
    '        urllib.request.urlopen(base + "/nope")',
    '    except urllib.error.HTTPError as e:',
    '        return e.code',
    '',
    'def refused():',
    '    try:',
    '        urllib.request.urlopen("http://127.0.0.1:1/x", timeout=2)',
    '    except OSError:',
    '        return "refused"',
    '',
    'def raw():',
    '    s = socket.create_connection(("127.0.0.1", port))',
    '    s.close()',
    '',
    'print(len(fetch_users()), login(), missing(), refused())',
    'raw()'
  ].join('\n'),
  'rec.py': [
    'def fib(n):',
    '    return n if n < 2 else fib(n - 1) + fib(n - 2)',
    'def deep(n):',
    '    return 0 if n == 0 else deep(n - 1)',
    'def plain(x):',
    '    return x + 1',
    'print(fib(4), deep(400), plain(1))'
  ].join('\n'),
  'data.py': [
    'class Dtypes:',
    '    def __init__(self, pairs):',
    '        self.pairs = pairs',
    '    def items(self):',
    '        return iter(self.pairs)',
    '',
    'class Frame:',
    '    """Looks like a pandas DataFrame (pandas may not be installed)."""',
    '    def __init__(self, rows, cols):',
    '        self.rows, self.cols = rows, cols',
    '    shape = property(lambda self: (len(self.rows), len(self.cols)))',
    '    columns = property(lambda self: self.cols)',
    '    dtypes = property(lambda self: Dtypes([(c, "int64") for c in self.cols]))',
    '    index = property(lambda self: list(range(len(self.rows))))',
    '    def head(self, n):',
    '        return Frame(self.rows[:n], self.cols)',
    '    def itertuples(self, index=False, name=None):',
    '        return iter([tuple(r) for r in self.rows])',
    '',
    'def load(n):',
    '    return Frame([[i, i * i] for i in range(n)], ["a", "b"])',
    '',
    'def pipeline(n):',
    '    df = load(n)',
    '    small = df.head(2)',
    '    names = [{"x": 1, "y": "a"}, {"x": 2}]',
    '    total = 0',
    '    for i in range(1, 6):',
    '        total += i',
    '    return small',
    '',
    'pipeline(10)',
    'pipeline(3)'
  ].join('\n'),
  'libs.py': [
    'import asyncio, sys',
    'import requests, httpx, aiohttp',
    'base = "http://127.0.0.1:%s" % sys.argv[1]',
    '',
    'def with_requests():',
    '    return requests.get(base + "/users", headers={"X-Api-Key": "SECRET5"}).status_code',
    '',
    'def with_httpx():',
    '    return httpx.get(base + "/users").status_code',
    '',
    'async def with_httpx_async():',
    '    async with httpx.AsyncClient() as c:',
    '        return (await c.get(base + "/nope")).status_code',
    '',
    'async def with_aiohttp():',
    '    async with aiohttp.ClientSession() as s:',
    '        async with s.get(base + "/users") as r:',
    '            await r.read()',
    '            return r.status',
    '',
    'print(with_requests(), with_httpx(), asyncio.run(with_httpx_async()), asyncio.run(with_aiohttp()))'
  ].join('\n')
}

/** A small web server for the network tests: /users (JSON), /login (201), anything else 404. */
function testServer() {
  return createHttpServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url?.startsWith('/users')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=SECRET4' })
        res.end(JSON.stringify([{ id: 1 }, { id: 2 }]))
      } else if (req.url === '/login') {
        res.writeHead(201, { 'Content-Type': 'text/plain' })
        res.end('ok')
      } else {
        res.writeHead(404)
        res.end('not here')
      }
    })
  })
}

function hasModules(...names: string[]): boolean {
  if (!python) return false
  try {
    execFileSync(python, ['-c', names.map((n) => `import ${n}`).join(';')], { stdio: 'ignore', timeout: 30000 })
    return true
  } catch {
    return false
  }
}

let root = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-trace-'))
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function run(target: string[], args: string[] = [], opts: { port?: number; env?: Record<string, string> } = {}) {
  const messages: unknown[] = []
  const server = await openTraceServer((m) => messages.push(m))
  const env = { ...process.env, ...traceEnv(root, opts.port ?? server.port, server.token), ...opts.env }
  const child = spawn(python!, traceCommand(target, args), { cwd: root, env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  await new Promise((r) => setTimeout(r, 50))
  server.close()
  return { messages, stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n'), code }
}

describe.skipIf(!python)('run tracer (real Python)', () => {
  it('sends hello, where it is at, the calls made, and end', async () => {
    const r = await run([join(root, 'main.py')], ['--x', 'y'])
    expect(r.code).toBe(0)
    const [hello, ...rest] = r.messages as { t: string; token?: string; at?: string | null; calls?: [string, string, number][] }[]
    expect(hello.t).toBe('hello')
    expect(rest.at(-1)!.t).toBe('end')
    const calls = new Map<string, number>()
    for (const m of rest) for (const [from, to, n] of m.calls ?? []) calls.set(`${from}→${to}`, (calls.get(`${from}→${to}`) ?? 0) + n)
    expect(calls.get('module:main→main:start')).toBe(1)
    expect(calls.get('main:start→pkg.b:work')).toBe(5)
    expect([...calls.keys()].some((k) => k.includes('runpy') || k.includes('<string>'))).toBe(false)
  })

  it('the program behaves as if it were not traced', async () => {
    const r = await run([join(root, 'main.py')], ['--x', 'y'])
    expect(r.stdout).toBe("argv ['--x', 'y']\npath0 is script dir True\ntotal 20\n")
    expect(r.stderr).toBe('')
  })

  it('exit codes and tracebacks are the program\'s own', async () => {
    expect((await run([join(root, 'exit3.py')])).code).toBe(3)
    const f = await run([join(root, 'fail.py')])
    expect(f.code).toBe(1)
    const files = [...f.stderr.matchAll(/File "([^"]+)"/g)].map((m) => m[1])
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(file).toContain('fail.py')
    expect(f.stderr).toContain('ValueError: bad')
  })

  it('-m runs a module as __main__', async () => {
    const r = await run(['-m', 'pkg.b'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('b as main 8\n')
  })

  it.skipIf(!hasModules('requests', 'httpx', 'aiohttp'))('reports requests made with requests, httpx (sync and async) and aiohttp', async () => {
    const server = testServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      const r = await run([join(root, 'libs.py')], [String(port)])
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('200 200 404 200\n')
      type Rec = { id: number; kind: string; lib: string; method: string; url: string; status: number | null; func: string | null; respBody: string | null }
      const recs = new Map<number, Rec>()
      for (const m of r.messages as { t: string; r?: Rec }[]) if (m.t === 'net') recs.set(m.r!.id, m.r!)
      const all = [...recs.values()].sort((a, b) => a.id - b.id)
      expect(all.map((x) => `${x.kind} ${x.lib} ${x.method} ${x.url.replace(String(port), 'PORT')} ${x.status} ${x.func}`)).toEqual([
        'http requests GET http://127.0.0.1:PORT/users 200 libs:with_requests',
        'http httpx GET http://127.0.0.1:PORT/users 200 libs:with_httpx',
        'http httpx GET http://127.0.0.1:PORT/nope 404 libs:with_httpx_async',
        'http aiohttp GET http://127.0.0.1:PORT/users 200 libs:with_aiohttp'
      ])
      expect(all[1].respBody).toBe('[{"id":1},{"id":2}]')
      expect(all[3].respBody).toBe('[{"id":1},{"id":2}]')
      expect(JSON.stringify(r.messages)).not.toMatch(/SECRET/)
    } finally {
      server.close()
    }
  }, 30000)

  it('reports each web request and connection, with secrets masked', async () => {
    const server = testServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      const r = await run([join(root, 'net.py')], [String(port)])
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('2 201 404 refused\n')
      type Rec = { id: number; kind: string; lib: string; method: string; url: string; host: string; status: number | null; error: string | null; ms: number | null; func: string | null; reqHeaders: [string, string][]; respHeaders: [string, string][]; reqBody: string | null; respBody: string | null }
      // Records are re-sent as they fill in (status, then body): keep the last of each.
      const recs = new Map<number, Rec>()
      for (const m of r.messages as { t: string; r?: Rec }[]) if (m.t === 'net') recs.set(m.r!.id, m.r!)
      const all = [...recs.values()].sort((a, b) => a.id - b.id)
      expect(all.map((x) => `${x.kind} ${x.method} ${x.url} ${x.status ?? (x.error ? 'error' : '')} ${x.func}`)).toEqual([
        `http GET http://127.0.0.1:${port}/users?page=2&api_key=•••• 200 net:fetch_users`,
        `http POST http://127.0.0.1:${port}/login 201 net:login`,
        `http GET http://127.0.0.1:${port}/nope 404 net:missing`,
        'http GET http://127.0.0.1:1/x error net:refused',
        `socket CONNECT 127.0.0.1:${port}  net:raw`
      ])
      expect(all[0].lib).toBe('urllib')
      expect(all[0].reqHeaders).toContainEqual(['Authorization', '••••'])
      expect(all[0].respHeaders).toContainEqual(['Set-Cookie', '••••'])
      expect(all[0].respBody).toBe('[{"id":1},{"id":2}]')
      expect(all[0].ms).toBeGreaterThanOrEqual(0)
      expect(all[1].reqBody).toBe('{"name": "ann", "password": "••••"}')
      expect(JSON.stringify(r.messages)).not.toMatch(/SECRET/)
    } finally {
      server.close()
    }
  })

  it('records recursion as a tree of calls: arguments in, value returned (capped)', async () => {
    const r = await run([join(root, 'rec.py')])
    expect(r.stdout).toBe('3 0 2\n')
    type Tree = { key: string; func: string; nodes: [number, string, string | null][]; total: number }
    const trees = new Map<string, Tree>()
    for (const m of r.messages as { t: string; tree?: Tree }[]) if (m.t === 'rec') trees.set(m.tree!.key, m.tree!)
    const all = [...trees.values()].sort((a, b) => Number(a.key.split('#')[1]) - Number(b.key.split('#')[1]))
    expect(all.map((t) => t.func)).toEqual(['rec:fib', 'rec:deep'])
    const fib = all[0]
    expect(fib.total).toBe(9)
    expect(fib.nodes[0]).toEqual([-1, '4', '3'])
    expect(fib.nodes[1]).toEqual([0, '3', '2'])
    expect(fib.nodes.filter((n) => n[0] === 0).map((n) => n[1])).toEqual(['3', '2'])
    const deep = all[1]
    expect(deep.total).toBe(401)
    expect(deep.nodes.length).toBe(300)
  })

  it('watched function: what each line produced (DataFrames: shape, columns, rows); every function: inputs and output', async () => {
    const r = await run([join(root, 'data.py')], [], { env: { FORGE_TRACE_DATA: 'data:pipeline' } })
    expect(r.stderr).toBe('')
    type Summary = { type: string; kind: string; shape?: number[]; columns?: [string, string][]; rows?: string[][]; len?: number; repr?: string }
    const data = (r.messages as { t: string; func?: string; line?: number; var?: string; n?: number; summary?: Summary }[]).filter((m) => m.t === 'data')
    expect(data.every((d) => d.func === 'data:pipeline')).toBe(true)
    const at = (v: string) => data.filter((d) => d.var === v)
    expect(at('df')).toHaveLength(1)
    expect(at('df')[0]).toMatchObject({ line: 24, summary: { kind: 'dataframe', type: '__main__.Frame', shape: [10, 2], columns: [['a', 'int64'], ['b', 'int64']] } })
    expect(at('df')[0].summary!.rows).toEqual([['0', '0'], ['1', '1'], ['2', '4'], ['3', '9'], ['4', '16']])
    expect(at('small')[0].summary!.shape).toEqual([2, 2])
    expect(at('names')[0].summary).toMatchObject({ kind: 'sequence', len: 2, columns: [['x', ''], ['y', '']], rows: [['1', "'a'"], ['2', 'None']] })
    // In a loop, the same line is reported a few times, not every time.
    expect(at('total').map((d) => d.summary!.repr)).toEqual(['0', '1', '3', '6'])
    expect(at('(returned)')).toHaveLength(1)
    // Only the first call is traced line by line.
    expect(at('df').every((d) => d.summary!.shape![0] === 10)).toBe(true)

    type Io = { func: string; total: number; calls: { in: Record<string, Summary>; out: Summary | null }[] }
    const io = new Map<string, Io>()
    for (const m of r.messages as { t: string; io?: Io }[]) if (m.t === 'io') io.set(m.io!.func, m.io!)
    const load = io.get('data:load')!
    expect(load.total).toBe(2)
    expect(load.calls.map((c) => `${c.in.n.repr} -> ${c.out?.shape}`)).toEqual(['10 -> 10,2', '3 -> 3,2'])
    expect(io.get('data:pipeline')!.calls[0].out!.kind).toBe('dataframe')
  })

  it('no connection: the program still runs, untraced', async () => {
    const r = await run([join(root, 'main.py')], [], { port: 1 })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('total 20')
    expect(r.messages).toEqual([])
  })
})
