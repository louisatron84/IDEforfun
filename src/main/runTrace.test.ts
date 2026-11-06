/**
 * The run tracer with a real Python (skipped if there is none): the program
 * behaves exactly as untraced, and Forge gets "where it's at" updates.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  'exit3.py': 'import sys\nsys.exit(3)\n'
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

async function run(target: string[], args: string[] = [], opts: { port?: number } = {}) {
  const messages: unknown[] = []
  const server = await openTraceServer((m) => messages.push(m))
  const env = { ...process.env, ...traceEnv(root, opts.port ?? server.port, server.token) }
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

  it('no connection: the program still runs, untraced', async () => {
    const r = await run([join(root, 'main.py')], [], { port: 1 })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('total 20')
    expect(r.messages).toEqual([])
  })
})
