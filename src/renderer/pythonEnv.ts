/**
 * Python environments and packages for the open project:
 *  - which interpreter it uses (status bar 🐍; pick another, or create a .venv)
 *  - its packages (install, upgrade, uninstall, freeze to requirements.txt)
 *  - packages that requirements.txt / pyproject.toml ask for but aren't installed
 * The chosen interpreter is saved in the project's .forge/settings.json.
 * pip and venv run in the Output panel, so you can see what they do.
 */
import type { InterpreterInfo } from '../shared/api'
import { isInstallableSpec, type Requirement } from '../shared/deps'
import type { Palette } from './palette'
import { isInside } from './workspace'

export interface PythonTool {
  /** The interpreter to run (full path). */
  python: string
  module: 'pip' | 'venv' | 'ensurepip'
  args: string[]
}

export interface PythonEnvHooks {
  palette: Palette
  root(): string | null
  /** The interpreter set in settings (yours or the project's), if any. */
  configuredPython(): string | undefined
  /** Save the project's interpreter (a path, relative to the project if inside it; undefined = automatic). */
  setProjectPython(path: string | undefined): Promise<void>
  /** Run python -m pip / venv in the Output panel; `after` gets the exit code. */
  runTool(title: string, tool: PythonTool, after?: (code: number | null) => void): Promise<void>
  /** Write a project file (e.g. requirements.txt); false if it couldn't (the hook says why). */
  writeFile(path: string, text: string): Promise<boolean>
  openFile(path: string): void
  /** Something shown in the status bar changed. */
  changed(): void
  /** The interpreter was (re)checked: installed tools may have changed. */
  envChanged?(): void
  report(message: string): void
}

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** "3.12.1 (.venv)" or "3.12.1" for an interpreter. */
export function interpreterLabel(info: InterpreterInfo): string {
  const env = info.isVenv ? ` (${info.prefix.replace(/[\\/]+$/, '').split(/[\\/]/).pop()})` : ''
  return `Python ${info.version}${env}`
}

export class PythonEnv {
  /** The interpreter Run / Debug / Pyright use (null: none found, or no folder). */
  current: InterpreterInfo | null = null
  /** Declared dependencies that aren't installed. */
  missing: Requirement[] = []
  /** Which of requirements.txt / pyproject.toml the project has. */
  sources: string[] = []
  private generation = 0
  private checked = false

  constructor(private readonly hooks: PythonEnvHooks) {}

  /** Find the interpreter in use and check the dependencies (after opening a folder, changing settings, pip runs...). */
  async refresh(): Promise<void> {
    const root = this.hooks.root()
    const gen = ++this.generation
    if (!root) {
      this.current = null
      this.missing = []
      this.sources = []
      this.checked = false
      this.hooks.changed()
      return
    }
    const current = await window.api.currentInterpreter(root, this.hooks.configuredPython()).catch(() => null)
    if (gen !== this.generation) return
    this.current = current
    this.checked = !!current
    this.hooks.changed()
    this.hooks.envChanged?.()
    if (!current) {
      this.missing = []
      return
    }
    const res = await window.api.checkDependencies(root, current.path).catch(() => null)
    if (gen !== this.generation) return
    this.missing = res?.missing ?? []
    this.sources = res?.sources ?? []
    this.hooks.changed()
  }

  /** Status bar text for the interpreter. */
  get statusText(): string {
    if (!this.hooks.root()) return ''
    if (!this.current) return this.checked ? '🐍 No Python' : '🐍 …'
    return `🐍 ${interpreterLabel(this.current).replace('Python ', '')}`
  }

  /** Status bar text for missing packages ('' when none). */
  get missingText(): string {
    const n = this.missing.length
    return n ? `⚠ ${n} missing package${n > 1 ? 's' : ''}` : ''
  }

  // ---------- interpreter ----------

  async pickInterpreter(): Promise<void> {
    const root = this.hooks.root()
    if (!root) return
    const { palette } = this.hooks
    palette.choose('Looking for Python interpreters…', [])
    const found = await window.api.findInterpreters(root).catch(() => [] as InterpreterInfo[])
    if (!palette.isOpen) return // closed while searching
    const configured = this.hooks.configuredPython()
    const same = (a: string, b: string) => (isWindowsPath(a) ? a.toLowerCase() === b.toLowerCase() : a === b)
    const items = [
      {
        label: 'Automatic',
        detail: "the project's .venv if it has one, else python on PATH",
        hint: configured ? undefined : '✓',
        run: () => void this.choose(undefined)
      },
      ...found.map((info) => ({
        label: interpreterLabel(info),
        detail: info.path,
        hint: this.current && same(this.current.path, info.path) && configured ? '✓' : isInside(info.path, root) ? 'project' : undefined,
        run: () => void this.choose(info.path)
      })),
      { label: 'Create a virtual environment (.venv)…', detail: 'python -m venv .venv in this project', run: () => setTimeout(() => void this.createVenv(found)) },
      { label: 'Enter interpreter path…', run: () => setTimeout(() => this.enterPath()) }
    ]
    palette.choose('Python interpreter for this project (Run, Debug, errors and completion)', items)
  }

  private enterPath(): void {
    this.hooks.palette.prompt('Path to python (e.g. C:\\Python312\\python.exe or .venv/bin/python)', (text) => void this.choose(text), '', 'Use')
  }

  /** Save the choice (relative to the project when it's inside it) and re-check. */
  private async choose(path: string | undefined): Promise<void> {
    const root = this.hooks.root()
    if (!root) return
    let value = path
    if (path && isInside(path, root)) {
      value = path.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    }
    try {
      await this.hooks.setProjectPython(value)
    } catch (err) {
      this.hooks.report(`Couldn't save the interpreter choice: ${String(err)}`)
      return
    }
    await this.refresh()
    if (path && !this.current) this.hooks.report(`That interpreter didn't run:\n${path}`)
  }

  async createVenv(known?: InterpreterInfo[]): Promise<void> {
    const root = this.hooks.root()
    if (!root) return
    const found = known ?? (await window.api.findInterpreters(root).catch(() => [] as InterpreterInfo[]))
    const existing = found.find((i) => i.isVenv && isInside(i.prefix, root) && /[\\/]\.venv$/.test(i.prefix.replace(/[\\/]+$/, '')))
    if (existing) {
      this.hooks.palette.choose('This project already has a .venv', [
        { label: `Use it (${interpreterLabel(existing)})`, run: () => void this.choose(existing.path) },
        { label: 'Cancel', run: () => {} }
      ])
      return
    }
    const bases = found.filter((i) => !i.isVenv)
    if (!bases.length) {
      this.hooks.report('No Python installation was found to create the environment from. Install Python from python.org first.')
      return
    }
    const create = (base: InterpreterInfo) => {
      const sep = isWindowsPath(root) ? '\\' : '/'
      const target = root.replace(/[\\/]+$/, '') + sep + '.venv'
      void this.hooks.runTool(`Creating .venv with ${interpreterLabel(base)}`, { python: base.path, module: 'venv', args: [target] }, (code) => {
        if (code !== 0) return
        const python = isWindowsPath(root) ? '.venv/Scripts/python.exe' : '.venv/bin/python'
        void this.hooks.setProjectPython(python).then(() => this.refresh()).then(() => this.offerInstallAfterCreate())
      })
    }
    if (bases.length === 1) return create(bases[0])
    this.hooks.palette.choose('Create the .venv from which Python?', bases.map((b) => ({ label: interpreterLabel(b), detail: b.path, run: () => create(b) })))
  }

  private offerInstallAfterCreate(): void {
    if (!this.sources.length) return
    this.hooks.palette.choose('The .venv is ready and selected. Install the project\'s packages into it?', [
      ...this.installChoices(),
      { label: 'Not now', run: () => {} }
    ])
  }

  // ---------- packages ----------

  private pip(title: string, args: string[]): void {
    const python = this.current?.path
    if (!python) {
      this.hooks.report('No Python interpreter was found for this project. Pick one first (click 🐍 in the status bar).')
      return
    }
    void this.hooks.runTool(title, { python, module: 'pip', args: [...args, '--disable-pip-version-check'] }, () => void this.refresh())
  }

  private installChoices(): { label: string; detail?: string; run: () => void }[] {
    const out: { label: string; detail?: string; run: () => void }[] = []
    if (this.sources.includes('requirements.txt')) {
      out.push({ label: 'Install from requirements.txt', detail: 'pip install -r requirements.txt', run: () => this.installRequirements() })
    }
    if (this.sources.includes('pyproject.toml')) {
      out.push({ label: 'Install this project (editable)', detail: 'pip install -e .', run: () => this.pip('pip install -e .', ['install', '-e', '.']) })
    }
    return out
  }

  /** pip install one package (e.g. pytest), then re-check. */
  install(spec: string): void {
    this.pip(`pip install ${spec}`, ['install', spec])
  }

  installRequirements(): void {
    if (!this.sources.includes('requirements.txt')) {
      this.hooks.report('This project has no requirements.txt.')
      return
    }
    this.pip('pip install -r requirements.txt', ['install', '-r', 'requirements.txt'])
  }

  installMissing(): void {
    const names = this.missing.map((r) => r.name + r.spec.replace(/;.*$/, '').replace(/^\s*@.*$/, '').replace(/\s+/g, ''))
    if (!names.length) return
    this.pip(`pip install ${names.join(' ')}`, ['install', ...names])
  }

  /** Clicking "⚠ n missing packages". */
  showMissing(): void {
    if (!this.missing.length) return
    this.hooks.palette.choose(`Not installed in ${this.current ? interpreterLabel(this.current) : 'this interpreter'}`, [
      { label: `Install the missing package${this.missing.length > 1 ? 's' : ''}`, detail: this.missing.map((r) => r.name).join(', '), run: () => this.installMissing() },
      ...this.installChoices(),
      ...this.missing.map((r) => ({ label: r.name, detail: r.spec || 'any version', hint: `from ${this.sources.join(' / ')}`, run: () => {} }))
    ])
  }

  /** "Python Packages…": installed packages and what to do with them. */
  async showPackages(): Promise<void> {
    const python = this.current?.path
    if (!python) {
      await this.refresh()
      if (!this.current) {
        this.hooks.report('No Python interpreter was found for this project. Pick one first (click 🐍 in the status bar).')
        return
      }
    }
    const info = this.current!
    const { palette } = this.hooks
    palette.choose('Reading installed packages…', [])
    const res = await window.api.listPackages(info.path).catch((err) => ({ packages: [], error: String(err) }))
    if (!palette.isOpen) return
    if (res.error) {
      palette.choose(`Couldn't list packages: ${res.error}`, [
        { label: 'Install pip', detail: 'python -m ensurepip --upgrade', run: () => this.ensurePip(info.path) }
      ])
      return
    }
    const actions = [
      { label: 'Install a package…', detail: 'pip install <name>', run: () => setTimeout(() => this.promptInstall()) },
      ...this.installChoices(),
      ...(this.missing.length ? [{ label: `Install ${this.missing.length} missing`, detail: this.missing.map((r) => r.name).join(', '), run: () => this.installMissing() }] : []),
      { label: 'Save installed packages to requirements.txt', detail: 'pip freeze > requirements.txt', run: () => void this.freezeToFile() },
      { label: 'Upgrade pip', detail: 'pip install --upgrade pip', run: () => this.pip('pip install --upgrade pip', ['install', '--upgrade', 'pip']) }
    ]
    const packages = res.packages
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ label: p.name, hint: p.version, detail: undefined, run: () => setTimeout(() => this.packageActions(p.name, p.version)) }))
    palette.choose(`${interpreterLabel(info)}: ${packages.length} packages installed`, [...actions, ...packages])
  }

  private ensurePip(python: string): void {
    void this.hooks.runTool('python -m ensurepip --upgrade', { python, module: 'ensurepip', args: ['--upgrade'] }, () => void this.refresh())
  }

  private promptInstall(): void {
    this.hooks.palette.prompt('Package to install, e.g. requests or "fastapi>=0.110"', (text) => {
      const spec = text.trim().replace(/^["']|["']$/g, '')
      if (!isInstallableSpec(spec)) {
        this.hooks.report(`"${spec}" doesn't look like a package name. Use a name like requests, uvicorn[standard] or numpy==1.26.4.`)
        return
      }
      this.pip(`pip install ${spec}`, ['install', spec.replace(/\s+/g, '')])
    }, '', 'Install')
  }

  private packageActions(name: string, version: string): void {
    this.hooks.palette.choose(`${name} ${version}`, [
      { label: `Upgrade ${name}`, detail: `pip install --upgrade ${name}`, run: () => this.pip(`pip install --upgrade ${name}`, ['install', '--upgrade', name]) },
      { label: `Uninstall ${name}`, detail: `pip uninstall -y ${name}`, run: () => this.pip(`pip uninstall ${name}`, ['uninstall', '-y', name]) },
      { label: '← Back to packages', run: () => setTimeout(() => void this.showPackages()) }
    ])
  }

  private async freezeToFile(): Promise<void> {
    const root = this.hooks.root()
    const python = this.current?.path
    if (!root || !python) return
    const res = await window.api.pipFreeze(python).catch((err) => ({ text: '', error: String(err) }))
    if (res.error) return this.hooks.report(`pip freeze failed:\n${res.error}`)
    const path = root.replace(/[\\/]+$/, '') + (isWindowsPath(root) ? '\\' : '/') + 'requirements.txt'
    if (this.sources.includes('requirements.txt') && !confirm('Replace requirements.txt with the packages installed now?')) return
    if (await this.hooks.writeFile(path, res.text)) {
      this.hooks.openFile(path)
      void this.refresh()
    }
  }
}
