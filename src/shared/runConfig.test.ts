import { describe, expect, it } from 'vitest'
import { expand, inProject, normalizeRunFile, resolveConfiguration, resolveTask, splitArgs } from './runConfig'

describe('splitArgs', () => {
  it('splits on spaces and keeps quoted parts together', () => {
    expect(splitArgs('run --port 8000')).toEqual(['run', '--port', '8000'])
    expect(splitArgs(`--name "Ada Lovelace" --x 'a b' ""`)).toEqual(['--name', 'Ada Lovelace', '--x', 'a b', ''])
    expect(splitArgs('  ')).toEqual([])
    expect(splitArgs('"say \\"hi\\""')).toEqual(['say "hi"'])
  })
})

describe('normalizeRunFile', () => {
  it('keeps valid configurations and tasks', () => {
    const f = normalizeRunFile({
      configurations: [
        { name: 'Server', file: 'app.py', args: ['--port', 8000], env: { DEBUG: 1, 'bad key': 'x' }, cwd: 'src' },
        { name: 'Flask', module: 'flask', file: 'ignored.py', args: 'run --debug' },
        { name: 'Server', file: 'dupe.py' },
        { file: 'no-name.py' },
        'junk'
      ],
      tasks: [{ name: 'Lint', command: 'ruff check .' }, { name: 'No command' }, { name: 'Lint', command: 'dupe' }]
    })
    expect(f.configurations).toEqual([
      { name: 'Server', file: 'app.py', args: ['--port', '8000'], env: { DEBUG: '1' }, cwd: 'src' },
      { name: 'Flask', module: 'flask', args: ['run', '--debug'], env: {} }
    ])
    expect(f.tasks).toEqual([{ name: 'Lint', command: 'ruff check .' }])
  })
  it('gives empty lists for garbage', () => {
    expect(normalizeRunFile(null)).toEqual({ configurations: [], tasks: [] })
    expect(normalizeRunFile({ configurations: 'x', tasks: {} })).toEqual({ configurations: [], tasks: [] })
  })
})

describe('paths and variables', () => {
  it('makes paths relative to the project', () => {
    expect(inProject('/p', 'src/app.py')).toBe('/p/src/app.py')
    expect(inProject('/p', './src')).toBe('/p/src')
    expect(inProject('/p', '.')).toBe('/p')
    expect(inProject('/p', '/abs/x.py')).toBe('/abs/x.py')
    expect(inProject('C:\\p', 'src/app.py')).toBe('C:\\p\\src\\app.py')
    expect(inProject('C:\\p', 'D:\\x.py')).toBe('D:\\x.py')
  })
  it('replaces variables', () => {
    const vars = { project: '/p', file: '/p/src/a.py' }
    expect(expand('${file} in ${fileDir} of ${project}', vars)).toBe('/p/src/a.py in /p/src of /p')
    expect(expand('${file}', { project: '/p', file: null })).toBeNull()
    expect(expand('${project}/x', { project: '/p', file: null })).toBe('/p/x')
  })
})

describe('resolveConfiguration', () => {
  const vars = { project: '/p', file: '/p/src/a.py' }
  it('fills in the file, args, env and folder', () => {
    expect(resolveConfiguration({ name: 'S', file: 'app.py', args: ['--in', '${file}'], env: { HOME_DIR: '${project}' }, cwd: 'src' }, vars))
      .toEqual({ program: '/p/app.py', module: null, args: ['--in', '/p/src/a.py'], env: { HOME_DIR: '/p' }, cwd: '/p/src' })
  })
  it('runs the open file by default, in the project folder', () => {
    expect(resolveConfiguration({ name: 'C', args: [], env: {} }, vars))
      .toEqual({ program: '/p/src/a.py', module: null, args: [], env: {}, cwd: '/p' })
  })
  it('runs modules', () => {
    expect(resolveConfiguration({ name: 'M', module: 'pytest', args: ['-q'], env: {} }, { project: '/p', file: null }))
      .toEqual({ program: null, module: 'pytest', args: ['-q'], env: {}, cwd: '/p' })
  })
  it('says when the open file is needed but none is open', () => {
    expect(resolveConfiguration({ name: 'C', args: [], env: {} }, { project: '/p', file: null })).toHaveProperty('error')
  })
})

describe('resolveTask', () => {
  it('fills in variables and the folder', () => {
    expect(resolveTask({ name: 'T', command: 'python ${file}', cwd: 'src' }, { project: '/p', file: '/p/a.py' }))
      .toEqual({ command: 'python /p/a.py', cwd: '/p/src' })
    expect(resolveTask({ name: 'T', command: 'pytest' }, { project: '/p', file: null })).toEqual({ command: 'pytest', cwd: '/p' })
    expect(resolveTask({ name: 'T', command: 'x ${file}' }, { project: '/p', file: null })).toHaveProperty('error')
  })
})
