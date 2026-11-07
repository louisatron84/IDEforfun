/**
 * Runs the project analysis (projectScan.py, bundled as text) with the
 * project's own Python: the script comes in on stdin and the JSON result
 * goes out on stdout. It only reads files; the project's code is not run.
 * Text from the editor that isn't saved yet can be given (`overrides`), and
 * then counts instead of what's on disk.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import script from './projectScan.py?raw'
import type { RawFile, RawScan } from '../shared/projectGraph'
import { resolvePython } from './debugAdapter'

export const SCAN_SCRIPT = script

type Overrides = Readonly<Record<string, string>>

/** Run the script with these extra arguments; the parsed JSON it prints, or why it failed. */
async function runScript(python: string, root: string, overrides: Overrides | undefined, only: readonly string[] | null, timeoutMs: number): Promise<{ json?: unknown; error?: string }> {
  let dir: string | null = null
  const args = ['-X', 'utf8', '-', root]
  try {
    if ((overrides && Object.keys(overrides).length) || only) {
      // A private temp file (the editor text may hold anything).
      dir = await mkdtemp(join(tmpdir(), 'forge-scan-'))
      const file = join(dir, 'overrides.json')
      await writeFile(file, JSON.stringify(overrides ?? {}), { encoding: 'utf8', mode: 0o600 })
      args.push('--overrides', file)
      if (only) args.push('--only', ...only)
    }
    return await new Promise((resolve) => {
      let child
      try {
        child = spawn(python, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
      } catch (err) {
        resolve({ error: String(err) })
        return
      }
      const out: Buffer[] = []
      let stderr = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (t: string) => (stderr = (stderr + t).slice(-4000)))
      child.stdin.on('error', () => {})
      child.once('error', (err) => {
        clearTimeout(timer)
        resolve({ error: err.message })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) return resolve({ error: stderr.trim() || `The analysis stopped (exit code ${code})` })
        try {
          resolve({ json: JSON.parse(Buffer.concat(out).toString('utf8')) })
        } catch (err) {
          resolve({ error: `Couldn't read the analysis: ${String(err)}` })
        }
      })
      child.stdin.end(SCAN_SCRIPT, 'utf8')
    })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Run the scan with a given interpreter. */
export async function runScan(python: string, root: string, timeoutMs = 120_000, overrides?: Overrides): Promise<{ scan?: RawScan; error?: string }> {
  const r = await runScript(python, root, overrides, null, timeoutMs)
  return r.error ? { error: r.error } : { scan: r.json as RawScan }
}

/** Scan only these files (relative paths), e.g. the one being edited. */
export async function runScanFiles(python: string, root: string, rels: readonly string[], overrides?: Overrides, timeoutMs = 30_000): Promise<{ files?: RawFile[]; error?: string }> {
  const r = await runScript(python, root, overrides, rels, timeoutMs)
  return r.error ? { error: r.error } : { files: r.json as RawFile[] }
}

const noPython = 'Python was not found. Install it from python.org, or pick an interpreter (Ctrl+Shift+P → Select Python Interpreter).'

/** Analyse a project with its interpreter (configured, venv, or python on PATH). */
export async function scanProject(root: string, configured?: string, overrides?: Overrides): Promise<{ scan?: RawScan; error?: string }> {
  const python = await resolvePython(root, configured)
  if (!python) return { error: noPython }
  return runScan(python, root, 120_000, overrides)
}

export async function scanProjectFiles(root: string, rels: readonly string[], configured?: string, overrides?: Overrides): Promise<{ files?: RawFile[]; error?: string }> {
  const python = await resolvePython(root, configured)
  if (!python) return { error: noPython }
  return runScanFiles(python, root, rels, overrides)
}
