import { describe, expect, it } from 'vitest'
import {
  isInstallableSpec, missingPackages, normalizeName, parsePipList, parsePyprojectDependencies,
  parseRequirement, parseRequirementsTxt
} from './deps'

describe('normalizeName', () => {
  it('ignores case and -, _ and .', () => {
    expect(normalizeName('Django_REST.framework')).toBe('django-rest-framework')
  })
})

describe('parseRequirement', () => {
  it('splits the name from the spec', () => {
    expect(parseRequirement('requests[socks]>=2.0; python_version > "3.8"')).toEqual({ name: 'requests', spec: '[socks]>=2.0; python_version > "3.8"' })
    expect(parseRequirement('numpy')).toEqual({ name: 'numpy', spec: '' })
    expect(parseRequirement('pkg @ https://x/pkg.whl')).toEqual({ name: 'pkg', spec: '@ https://x/pkg.whl' })
  })
  it('only names URLs and paths with #egg=', () => {
    expect(parseRequirement('git+https://github.com/a/b.git#egg=bee')).toEqual({ name: 'bee', spec: '' })
    expect(parseRequirement('https://x/y.whl')).toBeNull()
    expect(parseRequirement('./local/pkg')).toBeNull()
  })
})

describe('parseRequirementsTxt', () => {
  it('reads names and skips comments and options', () => {
    const text = [
      '# web',
      'Flask>=2.0  # the framework',
      'requests==2.31.0',
      '-r other.txt',
      '--index-url https://example.org/simple',
      '-e git+https://github.com/a/b.git#egg=bee',
      'numpy \\',
      '  >=1.26',
      '',
      'flask'
    ].join('\n')
    expect(parseRequirementsTxt(text)).toEqual([
      { name: 'Flask', spec: '>=2.0' },
      { name: 'requests', spec: '==2.31.0' },
      { name: 'bee', spec: '' },
      { name: 'numpy', spec: '>=1.26' }
    ])
  })
})

describe('parsePyprojectDependencies', () => {
  it('reads [project] dependencies, on one line or several', () => {
    const text = `
[build-system]
requires = ["setuptools"]
dependencies = ["not-this"]

[project]
name = "demo"
dependencies = [
  "fastapi>=0.110",  # web
  'uvicorn[standard]',
  "pydantic; python_version >= '3.9'",
]

[project.optional-dependencies]
dev = ["pytest"]
`
    expect(parsePyprojectDependencies(text).map((r) => r.name)).toEqual(['fastapi', 'uvicorn', 'pydantic'])
    expect(parsePyprojectDependencies('[project]\ndependencies = ["a", "b>=1"]\n').map((r) => r.name)).toEqual(['a', 'b'])
  })
})

describe('missingPackages', () => {
  it('compares by normalized name', () => {
    const missing = missingPackages(
      [{ name: 'Flask', spec: '' }, { name: 'python_dateutil', spec: '' }, { name: 'numpy', spec: '' }],
      [{ name: 'flask', version: '3.0' }, { name: 'python-dateutil', version: '2.9' }]
    )
    expect(missing.map((r) => r.name)).toEqual(['numpy'])
  })
})

describe('parsePipList', () => {
  it('reads pip list --format=json and tolerates garbage', () => {
    expect(parsePipList('[{"name":"pip","version":"24.0"},{"x":1}]')).toEqual([{ name: 'pip', version: '24.0' }])
    expect(parsePipList('WARNING: blah')).toEqual([])
  })
})

describe('isInstallableSpec', () => {
  it('accepts package names with optional extras and versions, nothing else', () => {
    expect(isInstallableSpec('requests')).toBe(true)
    expect(isInstallableSpec('uvicorn[standard]>=0.29')).toBe(true)
    expect(isInstallableSpec('numpy==1.26.4')).toBe(true)
    expect(isInstallableSpec('rm -rf /')).toBe(false)
    expect(isInstallableSpec('a; echo hi')).toBe(false)
    expect(isInstallableSpec('')).toBe(false)
  })
})
