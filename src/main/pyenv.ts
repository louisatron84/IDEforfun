/**
 * Python environments: find the interpreters on this machine and in the
 * project (virtualenvs), describe one (version, is it a venv), list its
 * installed packages, and compare them with the project's requirements.
 * Creating venvs and running pip happens through the normal Run output
 * (see PythonRunner), so you can watch it.
 */
import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InterpreterInfo } from '../shared/api'
import {
  missingPackages, parsePipList, parsePyprojectDependencies, parseRequirementsTxt,
  type InstalledPackage, type Requirement
} from '../shared/deps'

function run(cmd: string, args: string[], timeout = 15000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : '') })
    })
  })
}

const DESCRIBE = 'import sys, json; print(json.dumps({"exe": sys.executable, "version": sys.version.split()[0], "venv": sys.prefix != sys.base_prefix, "prefix": sys.prefix}))'

/** What an interpreter is (null if it doesn't run, e.g. the Microsoft Store stub). */
export async function describePython(python: string): Promise<InterpreterInfo | null> {
  const r = await run(python, ['-c', DESCRIBE])
  if (!r.ok) return null
  try {
    const line = r.stdout.trim().split(/\r?\n/).pop() ?? ''
    const d = JSON.parse(line) as { exe: string; version: string; venv: boolean; prefix: string }
    if (typeof d.exe !== 'string' || !d.exe) return null
    return { path: d.exe, version: String(d.version), isVenv: !!d.venv, prefix: String(d.prefix) }
  } catch {
    return null
  }
}

const venvPython = (dir: string) =>
  process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python')

const exists = (p: string) => access(p).then(() => true, () => false)

/** Folders directly inside the project that are virtualenvs (have pyvenv.cfg). */
async function projectVenvs(root: string): Promise<string[]> {
  let names: string[] = []
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const found: string[] = []
  for (const name of names) {
    const dir = join(root, name)
    if ((await exists(join(dir, 'pyvenv.cfg'))) && (await exists(venvPython(dir)))) found.push(venvPython(dir))
  }
  return found
}

/** Interpreters on PATH and (Windows) registered with the py launcher. */
async function systemPythons(): Promise<string[]> {
  const out: string[] = []
  if (process.platform === 'win32') {
    const py = await run('py', ['-0p'])
    // Lines like " -V:3.12 *        C:\Python312\python.exe"
    if (py.ok) for (const m of py.stdout.matchAll(/([A-Za-z]:\\[^\r\n]*?python[w]?\.exe)/gi)) out.push(m[1].trim())
    const where = await run('where', ['python'])
    out.push(...where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  } else {
    // `which` fails if any name is missing, but still prints the ones it found.
    const which = await run('which', ['-a', 'python3', 'python'])
    out.push(...which.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  }
  return out
}

/** Every interpreter we can find, project venvs first. Each is checked by running it. */
export async function findInterpreters(root: string | null): Promise<InterpreterInfo[]> {
  const candidates = [...(root ? await projectVenvs(root) : []), ...(await systemPythons())]
  const seen = new Set<string>()
  const unique = candidates.filter((c) => {
    const k = process.platform === 'win32' ? c.toLowerCase() : c
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const infos = await Promise.all(unique.map((c) => describePython(c)))
  const result: InterpreterInfo[] = []
  const seenExe = new Set<string>()
  for (const info of infos) {
    if (!info) continue
    const k = process.platform === 'win32' ? info.path.toLowerCase() : info.path
    if (seenExe.has(k)) continue
    seenExe.add(k)
    result.push(info)
  }
  return result
}

/** `pip list` for an interpreter. */
export async function listPackages(python: string): Promise<{ packages: InstalledPackage[]; error?: string }> {
  const r = await run(python, ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], 60000)
  if (!r.ok) {
    const noPip = /No module named pip/i.test(r.stderr)
    return { packages: [], error: noPip ? "pip isn't installed in this interpreter." : r.stderr.trim().split(/\r?\n/).slice(-3).join('\n') }
  }
  return { packages: parsePipList(r.stdout.trim().split(/\r?\n/).find((l) => l.startsWith('[')) ?? '[]') }
}

/** `pip freeze` text (for writing requirements.txt). */
export async function freeze(python: string): Promise<{ text: string; error?: string }> {
  const r = await run(python, ['-m', 'pip', 'freeze', '--disable-pip-version-check'], 60000)
  return r.ok ? { text: r.stdout } : { text: '', error: r.stderr.trim() }
}

/** The project's declared dependencies (requirements.txt and pyproject.toml). */
export async function projectRequirements(root: string): Promise<{ sources: string[]; required: Requirement[] }> {
  const sources: string[] = []
  const required: Requirement[] = []
  const add = (list: Requirement[]) => {
    for (const r of list) if (!required.some((x) => x.name.toLowerCase() === r.name.toLowerCase())) required.push(r)
  }
  try {
    add(parseRequirementsTxt(await readFile(join(root, 'requirements.txt'), 'utf8')))
    sources.push('requirements.txt')
  } catch { /* none */ }
  try {
    const deps = parsePyprojectDependencies(await readFile(join(root, 'pyproject.toml'), 'utf8'))
    sources.push('pyproject.toml')
    add(deps)
  } catch { /* none */ }
  return { sources, required }
}

/** Which declared dependencies aren't installed in `python`. */
export async function checkDependencies(root: string, python: string): Promise<{ sources: string[]; required: Requirement[]; missing: Requirement[]; error?: string }> {
  const { sources, required } = await projectRequirements(root)
  if (!required.length) return { sources, required, missing: [] }
  const { packages, error } = await listPackages(python)
  if (error) return { sources, required, missing: [], error }
  return { sources, required, missing: missingPackages(required, packages) }
}
