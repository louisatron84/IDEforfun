/**
 * Runs the project analysis (projectScan.py, bundled as text) with the
 * project's own Python: the script comes in on stdin and the JSON result
 * goes out on stdout. It only reads files; the project's code is not run.
 */
import { spawn } from 'node:child_process'
import script from './projectScan.py?raw'
import type { RawScan } from '../shared/projectGraph'
import { resolvePython } from './debugAdapter'

export const SCAN_SCRIPT = script

/** Run the scan with a given interpreter. */
export function runScan(python: string, root: string, timeoutMs = 120_000): Promise<{ scan?: RawScan; error?: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, ['-X', 'utf8', '-', root], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
      })
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
        resolve({ scan: JSON.parse(Buffer.concat(out).toString('utf8')) as RawScan })
      } catch (err) {
        resolve({ error: `Couldn't read the analysis: ${String(err)}` })
      }
    })
    child.stdin.end(SCAN_SCRIPT, 'utf8')
  })
}

/** Analyse a project with its interpreter (configured, venv, or python on PATH). */
export async function scanProject(root: string, configured?: string): Promise<{ scan?: RawScan; error?: string }> {
  const python = await resolvePython(root, configured)
  if (!python) return { error: 'Python was not found. Install it from python.org, or pick an interpreter (Ctrl+Shift+P → Select Python Interpreter).' }
  return runScan(python, root)
}
