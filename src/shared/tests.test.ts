import { describe, expect, it } from 'vitest'
import { failureLine, findTests, isTestFile, parseJUnit, parseUnittest, pytestId, unittestId } from './tests'

describe('isTestFile', () => {
  it('matches test_*.py and *_test.py', () => {
    expect(isTestFile('tests/test_app.py')).toBe(true)
    expect(isTestFile('app_test.py')).toBe(true)
    expect(isTestFile('src/app.py')).toBe(false)
    expect(isTestFile('test_data.json')).toBe(false)
  })
})

describe('findTests', () => {
  it('finds test functions and methods of test classes, with lines', () => {
    const src = [
      'import unittest',            // 0
      '',                           // 1
      'def test_add():',            // 2
      '    def test_inner(): pass', // 3 (nested: not a test)
      '    assert 1 + 1 == 2',      // 4
      '',                           // 5
      'def helper(): pass',         // 6
      '',                           // 7
      'class TestMath:',            // 8
      '    """Docs',                // 9
      '    def test_fake(): pass',  // 10 (inside a docstring)
      '    """',                    // 11
      '    def test_mul(self):',    // 12
      '        pass',               // 13
      '    async def test_async(self):', // 14
      '        pass',               // 15
      '',                           // 16
      'class Helper:',              // 17
      '    def test_not_collected(self): pass', // 18
      '',                           // 19
      'class Cases(unittest.TestCase):', // 20
      '    def test_eq(self):',     // 21
      '        self.assertEqual(1, 1)', // 22
      '    def setUp(self): pass',  // 23
      'def test_last(): pass'       // 24
    ].join('\n')
    expect(findTests(src)).toEqual([
      { name: 'test_add', className: null, line: 2, unittest: false },
      { name: 'test_mul', className: 'TestMath', line: 12, unittest: false },
      { name: 'test_async', className: 'TestMath', line: 14, unittest: false },
      { name: 'test_eq', className: 'Cases', line: 21, unittest: true },
      { name: 'test_last', className: null, line: 24, unittest: false }
    ])
  })
})

describe('ids', () => {
  it('builds pytest and unittest ids', () => {
    expect(pytestId('tests\\test_a.py', { name: 'test_x', className: 'TestK' })).toBe('tests/test_a.py::TestK::test_x')
    expect(pytestId('test_a.py', { name: 'test_x', className: null })).toBe('test_a.py::test_x')
    expect(unittestId('tests/test_a.py', { name: 'test_x', className: 'TestK' })).toBe('tests.test_a.TestK.test_x')
  })
})

describe('parseJUnit', () => {
  it('reads passed, failed, error and skipped cases', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1">
<testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" line="2" time="0.001" />
<testcase classname="tests.test_a.TestK" name="test_bad[1]" file="tests/test_a.py" line="9" time="0.002"><failure message="assert 1 == 2&#10;more">def test_bad():
&gt;   assert 1 == 2
E   assert 1 == 2

tests/test_a.py:11: AssertionError</failure></testcase>
<testcase classname="tests.test_a" name="test_skip" time="0"><skipped type="pytest.skip" message="not today">skip text</skipped></testcase>
<testcase classname="tests.test_a" name="test_err" time="0"><error message="fixture &apos;db&apos; not found" /></testcase>
</testsuite></testsuites>`
    const cases = parseJUnit(xml)
    expect(cases.map((c) => [c.classname, c.name, c.file, c.line, c.result.status, c.result.message])).toEqual([
      ['tests.test_a', 'test_ok', 'tests/test_a.py', 2, 'passed', ''],
      ['tests.test_a.TestK', 'test_bad[1]', 'tests/test_a.py', 9, 'failed', 'assert 1 == 2'],
      ['tests.test_a', 'test_skip', null, null, 'skipped', 'not today'],
      ['tests.test_a', 'test_err', null, null, 'error', "fixture 'db' not found"]
    ])
    expect(cases[1].result.details).toContain('>   assert 1 == 2')
    expect(failureLine(cases[1].result.details, 'tests/test_a.py')).toBe(10)
  })
})

describe('parseUnittest', () => {
  it('reads -v output (3.11+ and older formats) and failure tracebacks', () => {
    const out = `test_eq (tests.test_a.Cases.test_eq) ... ok
test_bad (tests.test_a.Cases)
Checks something. ... FAIL
test_skip (tests.test_a.Cases.test_skip) ... skipped 'later'
test_boom (tests.test_a.Cases.test_boom) ... ERROR

======================================================================
FAIL: test_bad (tests.test_a.Cases)
Checks something.
----------------------------------------------------------------------
Traceback (most recent call last):
  File "C:\\p\\tests\\test_a.py", line 9, in test_bad
    self.assertEqual(1, 2)
AssertionError: 1 != 2

======================================================================
ERROR: test_boom (tests.test_a.Cases.test_boom)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/p/tests/test_a.py", line 14, in test_boom
    raise ValueError("x")
ValueError: x

----------------------------------------------------------------------
Ran 4 tests in 0.002s

FAILED (failures=1, errors=1, skipped=1)
`
    const r = parseUnittest(out)
    expect(r.get('tests.test_a.Cases.test_eq')?.status).toBe('passed')
    expect(r.get('tests.test_a.Cases.test_skip')).toMatchObject({ status: 'skipped', message: 'later' })
    expect(r.get('tests.test_a.Cases.test_boom')).toMatchObject({ status: 'error', message: 'ValueError: x' })
    // The FAIL header carries a docstring line, so the details start after the dashes.
    const bad = r.get('tests.test_a.Cases.test_bad')
    expect(bad?.status).toBe('failed')
    expect(bad?.message).toBe('AssertionError: 1 != 2')
    expect(failureLine(bad!.details, 'tests/test_a.py')).toBe(8)
  })
})

describe('matchJUnit', () => {
  const files = [
    { path: '/p/tests/test_a.py', rel: 'tests/test_a.py', tests: [
      { name: 'test_ok', className: null, line: 1, unittest: false },
      { name: 'test_bad', className: 'TestK', line: 5, unittest: false },
      { name: 'test_p', className: null, line: 9, unittest: false }
    ] }
  ]
  const r = (status: 'passed' | 'failed', message = '') => ({ status, message, details: message, seconds: 0.1 })
  it('matches by file and class, merging parametrized cases', async () => {
    const { matchJUnit } = await import('./tests')
    const m = matchJUnit(files, [
      { classname: 'tests.test_a', name: 'test_ok', file: 'tests/test_a.py', line: 1, result: r('passed') },
      { classname: 'tests.test_a.TestK', name: 'test_bad', file: 'tests/test_a.py', line: 5, result: r('failed', 'boom') },
      { classname: 'tests.test_a', name: 'test_p[1]', file: null, line: null, result: r('passed') },
      { classname: 'tests.test_a', name: 'test_p[2]', file: null, line: null, result: r('failed', 'p2') }
    ])
    expect(m.get('tests/test_a.py::test_ok')?.status).toBe('passed')
    expect(m.get('tests/test_a.py::TestK::test_bad')?.message).toBe('boom')
    expect(m.get('tests/test_a.py::test_p')).toMatchObject({ status: 'failed', message: 'p2' })
  })
})
