import { describe, expect, it } from 'vitest'
import { testArgs } from './tests'

describe('test command lines', () => {
  it('unittest: discover comes first (it is a subcommand), then -v', () => {
    expect(testArgs({ framework: 'unittest', ids: [] }, 'x.xml')).toEqual(['-m', 'unittest', 'discover', '-v'])
    expect(testArgs({ framework: 'unittest', ids: ['tests.test_a.T.test_x'] }, 'x.xml')).toEqual(['-m', 'unittest', '-v', 'tests.test_a.T.test_x'])
  })

  it('pytest', () => {
    expect(testArgs({ framework: 'pytest', ids: ['t.py::a'] }, 'out.xml')).toEqual(['-m', 'pytest', '-o', 'junit_family=xunit1', '--junitxml=out.xml', '--color=no', '-q', 't.py::a'])
  })
})
