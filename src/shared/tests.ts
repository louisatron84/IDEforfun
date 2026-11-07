/**
 * Finding and reading the results of Python tests (pytest and unittest).
 *
 * Discovery reads test files directly (test_*.py / *_test.py): top-level
 * `def test_*` functions and `test_*` methods of `Test*` classes or
 * unittest.TestCase subclasses. That's what pytest collects by default, and
 * it gives line numbers for jumping to a test.
 * Results come from pytest's JUnit XML report, or unittest's -v output.
 */

export interface DiscoveredTest {
  name: string
  /** The class it's in, or null for a top-level function. */
  className: string | null
  /** 0-based line of the `def`. */
  line: number
  /** In a unittest.TestCase class (so unittest can run it too). */
  unittest: boolean
}

export interface TestFile {
  path: string
  /** Relative to the project, with / separators. */
  rel: string
  tests: DiscoveredTest[]
}

export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'notrun'

export interface TestResult {
  status: TestStatus
  /** One-line reason (assertion message, skip reason). */
  message: string
  /** Full traceback / details. */
  details: string
  seconds: number
}

/** Is this (relative) path a test file pytest would collect by default? */
export function isTestFile(rel: string): boolean {
  const name = rel.split(/[\\/]/).pop() ?? ''
  return /^test_.*\.py$/.test(name) || /^.+_test\.py$/.test(name)
}

/** Tests in a Python source file. */
export function findTests(source: string): DiscoveredTest[] {
  const out: DiscoveredTest[] = []
  const lines = source.split(/\r?\n/)
  /** The class we're inside: its indentation and whether it holds tests. */
  let cls: { name: string; indent: number; collect: boolean; unittest: boolean } | null = null
  let inString: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip the insides of triple-quoted strings (docstrings), roughly.
    if (inString) {
      if (line.includes(inString)) inString = null
      continue
    }
    const triple = /^\s*[rRbBuUfF]*("""|''')/.exec(line)
    if (triple && line.split(triple[1]).length === 2) {
      inString = triple[1]
      continue
    }
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (cls && indent <= cls.indent) cls = null
    const c = /^(\s*)class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*:/.exec(line)
    if (c) {
      if (c[1].length === 0) {
        const bases = c[4] ?? ''
        const unittest = /\bTestCase\b|\bIsolatedAsyncioTestCase\b/.test(bases)
        // pytest collects Test* classes (without __init__); unittest needs TestCase.
        cls = { name: c[2], indent: 0, collect: unittest || /^Test/.test(c[2]), unittest }
      }
      continue
    }
    const d = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line)
    if (!d) continue
    const defIndent = d[1].length
    if (defIndent === 0) out.push({ name: d[2], className: null, line: i, unittest: false })
    else if (cls && cls.collect && defIndent > cls.indent && isMethodLevel(lines, i, defIndent, cls.indent)) {
      out.push({ name: d[2], className: cls.name, line: i, unittest: cls.unittest })
    }
  }
  return out
}

/** A def directly in the class body (not nested in another method). */
function isMethodLevel(lines: string[], at: number, indent: number, classIndent: number): boolean {
  for (let j = at - 1; j >= 0; j--) {
    const l = lines[j]
    if (!l.trim() || /^\s*#/.test(l)) continue
    const ind = l.length - l.trimStart().length
    if (ind <= classIndent) return true // reached the class line
    if (ind < indent && /^\s*(async\s+)?def\s/.test(l)) return false // inside another def
    if (ind < indent) return true
  }
  return true
}

/** pytest's id for a test: path/to/test_x.py::Class::test_name. */
export function pytestId(rel: string, t: Pick<DiscoveredTest, 'name' | 'className'>): string {
  return [rel.replace(/\\/g, '/'), t.className, t.name].filter(Boolean).join('::')
}

/** unittest's id: path.to.test_x.Class.test_name (only for TestCase methods). */
export function unittestId(rel: string, t: Pick<DiscoveredTest, 'name' | 'className'>): string {
  const mod = rel.replace(/\\/g, '/').replace(/\.py$/, '').split('/').join('.')
  return [mod, t.className, t.name].filter(Boolean).join('.')
}

/**
 * The modules to give unittest for "run all": every test file by module name.
 * (unittest discover only looks in folders with an __init__.py, so a plain
 * tests/ folder would be skipped and nothing would run.)
 */
export function unittestModules(files: readonly { rel: string; tests: readonly { unittest?: boolean }[] }[]): string[] {
  return files.filter((f) => f.tests.some((t) => t.unittest)).map((f) => f.rel.replace(/\\/g, '/').replace(/\.py$/, '').split('/').join('.'))
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (_m, name: string, dec?: string, hex?: string) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[name]
  })

const attrs = (text: string) => {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2])
  return out
}

export interface JUnitCase {
  classname: string
  name: string
  /** With -o junit_family=xunit1: the file (relative to pytest's rootdir) and 0-based line. */
  file: string | null
  line: number | null
  result: TestResult
}

/** Read pytest's --junitxml report. */
export function parseJUnit(xml: string): JUnitCase[] {
  const out: JUnitCase[] = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1])
    const body = m[2] ?? ''
    let status: TestStatus = 'passed'
    let message = ''
    let details = ''
    const child = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    if (child) {
      status = child[1] === 'failure' ? 'failed' : child[1] === 'error' ? 'error' : 'skipped'
      const ca = attrs(child[2])
      message = ca.message ?? ''
      details = unescapeXml((child[3] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, ''))
    }
    out.push({
      classname: a.classname ?? '',
      name: a.name ?? '',
      file: a.file ?? null,
      line: a.line !== undefined && /^\d+$/.test(a.line) ? Number(a.line) : null,
      result: { status, message: message.split(/\r?\n/)[0].slice(0, 300), details, seconds: Number(a.time) || 0 }
    })
  }
  return out
}

/** Read `python -m unittest -v` output: id (module.Class.test) → result. */
export function parseUnittest(output: string): Map<string, TestResult> {
  const results = new Map<string, TestResult>()
  const idOf = (name: string, inParens: string) => (inParens.endsWith('.' + name) ? inParens : `${inParens}.${name}`)
  // "test_x (pkg.mod.Class.test_x) ... ok", possibly with a docstring line before " ... "
  for (const m of output.matchAll(/^(\w+) \(([\w.]+)\)(?:\n[^\n]*?)? \.\.\. (ok|FAIL|ERROR|skipped(?: '(.*)')?|expected failure|unexpected success)\s*$/gm)) {
    const word = m[3]
    const status: TestStatus = word === 'ok' || word === 'expected failure' ? 'passed'
      : word === 'FAIL' || word === 'unexpected success' ? 'failed'
      : word === 'ERROR' ? 'error' : 'skipped'
    results.set(idOf(m[1], m[2]), { status, message: m[4] ?? (word === 'unexpected success' ? 'unexpected success' : ''), details: '', seconds: 0 })
  }
  // Failure details: "=====\nFAIL: test_x (pkg.mod.Class.test_x)\n-----\n<traceback>"
  for (const m of output.matchAll(/^={20,}\r?\n(FAIL|ERROR): (\w+) \(([\w.]+)\)[^\n]*\r?\n(?:[^\n]*\r?\n)?-{20,}\r?\n([\s\S]*?)(?=\r?\n={20,}\r?\n|\r?\n-{20,}\r?\nRan |(?![\s\S]))/gm)) {
    const id = idOf(m[2], m[3])
    const details = m[4].trimEnd()
    const last = details.split(/\r?\n/).filter((l) => l.trim()).pop() ?? ''
    const prev = results.get(id)
    results.set(id, { status: m[1] === 'FAIL' ? 'failed' : 'error', message: last.slice(0, 300), details, seconds: prev?.seconds ?? 0 })
  }
  return results
}

/**
 * Where a failure happened in `file`, from a traceback: the last
 * `File "...", line N` (unittest) or `path:N: Error` (pytest) that is in
 * that file. Returns a 0-based line or null.
 */
export function failureLine(details: string, fileEndsWith: string): number | null {
  const want = fileEndsWith.replace(/\\/g, '/').toLowerCase()
  const matches = (p: string) => {
    const norm = p.replace(/\\/g, '/').toLowerCase()
    return norm === want || norm.endsWith('/' + want) || want.endsWith('/' + norm)
  }
  let found: number | null = null
  for (const m of details.matchAll(/File "([^"]+)", line (\d+)/g)) if (matches(m[1])) found = Number(m[2]) - 1
  for (const m of details.matchAll(/^([^\s:][^:\n]*\.py):(\d+): /gm)) if (matches(m[1])) found = Number(m[2]) - 1
  return found
}

const RANK: Record<TestStatus, number> = { notrun: 0, skipped: 1, passed: 2, failed: 3, error: 4 }

/** Combine results of the same test (parametrized cases): the worst status wins. */
function merge(a: TestResult | undefined, b: TestResult): TestResult {
  if (!a) return b
  const worst = RANK[b.status] > RANK[a.status] ? b : a
  const details = [a.details, b.details].filter(Boolean).join('\n\n')
  return { status: worst.status, message: worst.message, details, seconds: a.seconds + b.seconds }
}

/** Match pytest's report to the discovered tests: pytestId → result. */
export function matchJUnit(files: TestFile[], cases: JUnitCase[]): Map<string, TestResult> {
  const out = new Map<string, TestResult>()
  for (const c of cases) {
    const name = c.name.replace(/\[[\s\S]*\]$/, '')
    for (const f of files) {
      const mod = f.rel.replace(/\.py$/, '').split('/').join('.')
      if (c.file) {
        const file = c.file.replace(/\\/g, '/')
        if (!(file === f.rel || f.rel.endsWith('/' + file) || file.endsWith('/' + f.rel))) continue
      } else if (!(c.classname === mod || c.classname.startsWith(mod + '.') || mod.endsWith('.' + c.classname.split('.').slice(0, -1).join('.')))) {
        continue
      }
      // classname is "module.path" for functions and "module.path.Class" for methods.
      const last = c.classname.split('.').pop() ?? ''
      const moduleName = mod.split('.').pop()
      const test = f.tests.find((t) => t.name === name && (t.className === null ? last === moduleName : t.className === last))
      if (!test) continue
      const id = pytestId(f.rel, test)
      out.set(id, merge(out.get(id), c.result))
      break
    }
  }
  return out
}
