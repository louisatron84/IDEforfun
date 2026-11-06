/**
 * Runs the generated code with a real Python (skipped if there is none), with
 * urlopen replaced by a fake, and checks the CSV is exactly what the API box
 * previews.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newApiBox, type ApiBox, type BoxAuth } from '../shared/boxes'
import { generateBlock } from '../shared/boxCode'
import { csvPreview, pickRecords, rowsFor } from '../shared/apiFields'

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

const RESPONSE = {
  items: [
    { login: 'ann', plan: { name: 'pro' }, tags: ['a', 'b'], admin: true, note: 'say "hi", ok' },
    { login: 'bo', score: null, note: 'two\nlines', city: 'Zürich' }
  ],
  total: 2
}

const FAKE = (response: unknown) => `
import io, json, urllib.request
class _Response(io.BytesIO):
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
def _fake_urlopen(request, timeout=None):
    print("URL", request.full_url)
    print("AUTH", request.get_header("Authorization"))
    return _Response(${JSON.stringify(JSON.stringify(response))}.encode("utf-8"))
urllib.request.urlopen = _fake_urlopen
`

describe.skipIf(!python)('generated code (real Python)', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-boxcode-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function box(auth: BoxAuth = { kind: 'bearer', env: 'GITHUB_TOKEN' }): ApiBox {
    const b = newApiBox([], 'GitHub')
    b.baseUrl = 'https://api.github.com'
    b.auth = auth
    b.requests[0] = { ...b.requests[0], name: 'users', url: '/orgs/{org}/members', recordsPath: ['items'], ticked: ['login', 'plan.name', 'tags', 'admin', 'note', 'score', 'city'], testArgs: { org: 'acme' } }
    return b
  }

  it('writes the CSV the box previews', () => {
    const b = box()
    const out = join(dir, 'out.csv').replace(/\\/g, '/')
    const file = join(dir, 'gen.py')
    writeFileSync(file, FAKE(RESPONSE) + generateBlock(b, { main: false }) + `\nrows = github_users("acme", output_path="${out}")\nprint("ROWS", len(rows))\n`)
    const stdout = execFileSync(python!, ['-X', 'utf8', file], { env: { ...process.env, GITHUB_TOKEN: 'tok' }, encoding: 'utf8' })
    expect(stdout).toContain('URL https://api.github.com/orgs/acme/members')
    expect(stdout).toContain('AUTH Bearer tok')
    expect(stdout).toContain('ROWS 2')
    const req = b.requests[0]
    const expected = csvPreview(rowsFor(pickRecords(RESPONSE, req.recordsPath).records, req.ticked), req.ticked, Infinity)
    expect(readFileSync(out, 'utf8')).toBe(expected)
  })

  it('a missing secret is a clear error', () => {
    const file = join(dir, 'missing.py')
    writeFileSync(file, FAKE(RESPONSE) + generateBlock(box(), { main: false }) + '\ngithub_users("acme")\n')
    const env = { ...process.env }
    delete env.GITHUB_TOKEN
    let err = ''
    try {
      execFileSync(python!, ['-X', 'utf8', file], { env, encoding: 'utf8', stdio: 'pipe', cwd: dir })
    } catch (e) {
      err = String((e as { stderr?: string }).stderr)
    }
    expect(err).toContain('GITHUB_TOKEN is not set: add it to .env')
  })

  it('every auth kind compiles, with and without __main__', () => {
    const auths: BoxAuth[] = [
      { kind: 'none' },
      { kind: 'header', name: 'X-Api-Key', env: 'K' },
      { kind: 'query', name: 'key', env: 'K' },
      { kind: 'bearer', env: 'K' },
      { kind: 'basic', userEnv: 'U', passEnv: 'P' }
    ]
    auths.forEach((auth, i) => {
      for (const main of [true, false]) {
        const b = box(auth)
        b.requests[0].method = 'POST'
        b.requests[0].body = '{"a": [1, true, null], "b": "x"}'
        b.requests[0].headers = [{ key: 'X-Trace', value: '1' }]
        b.requests[0].query = [{ key: 'page', value: '1', arg: true }]
        b.requests[0].ticked = []
        const file = join(dir, `c${i}${main}.py`)
        writeFileSync(file, generateBlock(b, { main }))
        execFileSync(python!, ['-X', 'utf8', '-m', 'py_compile', file], { stdio: 'pipe' })
      }
    })
  })
})
