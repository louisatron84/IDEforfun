import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, listUserTemplates, saveTemplate } from './projectTemplates'
import { BUILTIN_TEMPLATES, moduleName, projectNameProblem, renderTemplate, safeTemplatePath, titleOf } from '../shared/templates'

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

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-templates-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('templates', () => {
  it('names: a Python name, a title, and names that can\'t be folders', () => {
    expect(moduleName('My Tool!')).toBe('my_tool')
    expect(moduleName('2048 game')).toBe('game_2048')
    expect(moduleName('2048')).toBe('p_2048')
    expect(moduleName('   ')).toBe('project')
    expect(titleOf('weather-bot')).toBe('Weather Bot')
    expect(projectNameProblem('')).toMatch(/Type a name/)
    expect(projectNameProblem('a/b')).toMatch(/can't contain/)
    expect(projectNameProblem('Weather bot')).toBeNull()
  })

  it('fills {{name}}, {{module}} and {{title}} in paths and contents, and leaves template syntax like {{ note }} alone', () => {
    const files = renderTemplate(BUILTIN_TEMPLATES.find((t) => t.id === 'cli')!, 'Weather Bot')
    expect(files.map((f) => f.path)).toContain('weather_bot.py')
    expect(files.map((f) => f.path)).toContain('tests/test_weather_bot.py')
    expect(files.find((f) => f.path === 'README.md')!.content).toMatch(/^# Weather Bot/)
    const flask = renderTemplate(BUILTIN_TEMPLATES.find((t) => t.id === 'flask')!, 'x')
    expect(flask.find((f) => f.path === 'templates/index.html')!.content).toContain('{{ note }}')
  })

  it('only safe relative paths', () => {
    expect(safeTemplatePath('a/b.py')).toBe(true)
    expect(safeTemplatePath('../x')).toBe(false)
    expect(safeTemplatePath('/etc/x')).toBe(false)
    expect(safeTemplatePath('C:/x')).toBe(false)
    expect(safeTemplatePath('a//b')).toBe(false)
  })

  it('every built-in template has a README and opens a file it has; every run.json is valid', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const files = renderTemplate(t, 'Demo App')
      expect(files.some((f) => f.path === 'README.md'), t.id).toBe(true)
      if (t.open) expect(files.map((f) => f.path), t.id).toContain(renderTemplate({ ...t, files: [{ path: t.open, content: '' }] }, 'Demo App')[0].path)
      for (const f of files.filter((x) => x.path.endsWith('.json'))) expect(() => JSON.parse(f.content), f.path).not.toThrow()
    }
  })

  it.skipIf(!python)('every built-in template\'s Python is valid Python', () => {
    const sources = BUILTIN_TEMPLATES.flatMap((t) => renderTemplate(t, 'Demo App').filter((f) => f.path.endsWith('.py')).map((f) => [`${t.id}/${f.path}`, f.content]))
    const out = execFileSync(python!, ['-c', 'import ast, json, sys\nbad = []\nfor name, src in json.load(sys.stdin):\n    try:\n        ast.parse(src)\n    except SyntaxError as e:\n        bad.append(f"{name}: {e}")\nprint(json.dumps(bad))'], { input: JSON.stringify(sources) })
    expect(JSON.parse(out.toString())).toEqual([])
  })
})

describe('making projects and saving templates', () => {
  it('makes the project folder with its files, and never into a folder that exists', async () => {
    const path = await createProject(dir, 'Weather Bot', renderTemplate(BUILTIN_TEMPLATES.find((t) => t.id === 'cli')!, 'Weather Bot'))
    expect(path).toBe(join(dir, 'Weather Bot'))
    expect(readFileSync(join(path, 'weather_bot.py'), 'utf8')).toContain('argparse')
    expect(existsSync(join(path, '.forge', 'run.json'))).toBe(true)
    await expect(createProject(dir, 'Weather Bot', [])).rejects.toThrow(/already exists/)
    await expect(createProject(dir, 'Bad', [{ path: '../escape.py', content: '' }])).rejects.toThrow(/won't write/)
    expect(existsSync(join(dir, 'escape.py'))).toBe(false)
  })

  it('saves a project as a template (its name becomes a placeholder; no .venv, .git or .env), and lists it', async () => {
    const root = join(dir, 'weather_bot')
    mkdirSync(join(root, '.venv'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'weather_bot.py'), 'print("weather_bot")\n')
    writeFileSync(join(root, 'tests', 'test_weather_bot.py'), 'import weather_bot\n')
    writeFileSync(join(root, '.env'), 'TOKEN=secret\n')
    writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'home = x\n')
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const store = join(dir, 'templates')
    const id = await saveTemplate(root, store, 'My bot')
    expect(id).toBe('my_bot')
    const [t] = await listUserTemplates(store)
    expect(t).toMatchObject({ id: 'user:my_bot', name: 'My bot', user: true })
    // The folder's name is a Python name, so it stands for the new project's Python name (importable files).
    expect(t.files.map((f) => f.path).sort()).toEqual(['tests/test_{{module}}.py', '{{module}}.py'])
    expect(t.files.find((f) => f.path === '{{module}}.py')!.content).toBe('print("{{module}}")\n')
    const made = renderTemplate(t, 'Rain Alert')
    expect(made.map((f) => f.path).sort()).toEqual(['rain_alert.py', 'tests/test_rain_alert.py'])
    expect(await saveTemplate(root, store, 'My bot')).toBe('my_bot_2')
  })
})
