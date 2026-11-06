/**
 * Run configurations and tasks, from <project>/.forge/run.json:
 *
 *   {
 *     "configurations": [
 *       { "name": "Server", "file": "app/main.py", "args": ["--port", "8000"],
 *         "env": { "DEBUG": "1" }, "cwd": "${project}" },
 *       { "name": "Flask", "module": "flask", "args": "run --debug" }
 *     ],
 *     "tasks": [
 *       { "name": "Install requirements", "command": "python -m pip install -r requirements.txt" }
 *     ]
 *   }
 *
 * A configuration runs a file (or a module, like python -m) with arguments,
 * environment variables and a working folder; Run and Debug both use it.
 * A task is any shell command, run in its own terminal.
 * ${file}, ${fileDir} and ${project} are replaced in every text value.
 */

export interface RunConfiguration {
  name: string
  /** The script to run (relative to the project); default ${file}, the open file. */
  file?: string
  /** Run a module instead of a file (python -m module). */
  module?: string
  args: string[]
  env: Record<string, string>
  /** Working folder (relative to the project); default the project folder. */
  cwd?: string
}

export interface Task {
  name: string
  command: string
  cwd?: string
}

export interface RunFile {
  configurations: RunConfiguration[]
  tasks: Task[]
}

export const RUN_FILE = 'run.json'

/** Split a command-line string into arguments, honouring "double" and 'single' quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let has = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) cur += text[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
    }
  }
  if (has || cur) out.push(cur)
  return out
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Turn run.json content (anything) into valid configurations and tasks; bad entries are dropped. */
export function normalizeRunFile(raw: unknown): RunFile {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const configurations: RunConfiguration[] = []
  for (const c of Array.isArray(r.configurations) ? r.configurations : []) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const name = str(o.name)
    if (!name || configurations.some((x) => x.name === name)) continue
    const args = typeof o.args === 'string' ? splitArgs(o.args)
      : Array.isArray(o.args) ? o.args.filter((a): a is string | number => typeof a === 'string' || typeof a === 'number').map(String) : []
    const env: Record<string, string> = {}
    if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][\w.-]*$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) env[k] = String(v)
      }
    }
    const cfg: RunConfiguration = { name, args, env }
    const module = str(o.module)
    if (module) cfg.module = module
    else if (str(o.file)) cfg.file = str(o.file)
    if (str(o.cwd)) cfg.cwd = str(o.cwd)
    configurations.push(cfg)
  }
  const tasks: Task[] = []
  for (const t of Array.isArray(r.tasks) ? r.tasks : []) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const name = str(o.name)
    const command = str(o.command)
    if (!name || !command || tasks.some((x) => x.name === name)) continue
    const task: Task = { name, command }
    if (str(o.cwd)) task.cwd = str(o.cwd)
    tasks.push(task)
  }
  return { configurations, tasks }
}

export interface Vars {
  project: string
  /** The open file, if any. */
  file: string | null
}

const isAbsolute = (p: string) => /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(p)
const sepOf = (root: string) => (root.includes('\\') ? '\\' : '/')
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

/** A path relative to the project (or already absolute). */
export function inProject(root: string, path: string): string {
  if (isAbsolute(path)) return path
  const sep = sepOf(root)
  const rel = path.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)
  return rel === '.' || rel === '' ? root : root.replace(/[\\/]+$/, '') + sep + rel
}

/** Replace ${file}, ${fileDir}, ${project}; returns null if ${file} is needed but no file is open. */
export function expand(text: string, vars: Vars): string | null {
  let missing = false
  const out = text.replace(/\$\{(file|fileDir|project)\}/g, (_m, name: string) => {
    if (name === 'project') return vars.project
    if (!vars.file) {
      missing = true
      return ''
    }
    return name === 'file' ? vars.file : dirOf(vars.file)
  })
  return missing ? null : out
}

/** Everything needed to start a configuration. */
export interface LaunchSpec {
  /** The script, or null when running a module. */
  program: string | null
  module: string | null
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** Fill in a configuration's variables and paths, or say why it can't run. */
export function resolveConfiguration(cfg: RunConfiguration, vars: Vars): LaunchSpec | { error: string } {
  const need = `"${cfg.name}" runs the open file, so open a Python file first.`
  const ex = (t: string) => expand(t, vars)
  const args: string[] = []
  for (const a of cfg.args) {
    const v = ex(a)
    if (v === null) return { error: need }
    args.push(v)
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg.env)) {
    const e = ex(v)
    if (e === null) return { error: need }
    env[k] = e
  }
  const cwdText = cfg.cwd ? ex(cfg.cwd) : vars.project
  if (cwdText === null) return { error: need }
  const cwd = inProject(vars.project, cwdText)
  if (cfg.module) return { program: null, module: cfg.module, args, env, cwd }
  const fileText = ex(cfg.file ?? '${file}')
  if (fileText === null || !fileText) return { error: need }
  return { program: inProject(vars.project, fileText), module: null, args, env, cwd }
}

/** A task's command and folder with variables filled in, or why it can't run. */
export function resolveTask(task: Task, vars: Vars): { command: string; cwd: string } | { error: string } {
  const command = expand(task.command, vars)
  const cwd = task.cwd ? expand(task.cwd, vars) : vars.project
  if (command === null || cwd === null) return { error: `"${task.name}" uses the open file, so open a file first.` }
  return { command, cwd: inProject(vars.project, cwd) }
}

/** What a new run.json starts with. */
export function starterRunFile(hasRequirements: boolean): RunFile {
  return {
    configurations: [
      { name: 'Current file', file: '${file}', args: [], env: {}, cwd: '${project}' }
    ],
    tasks: hasRequirements
      ? [{ name: 'Install requirements', command: 'python -m pip install -r requirements.txt' }]
      : [{ name: 'Python version', command: 'python --version' }]
  }
}
