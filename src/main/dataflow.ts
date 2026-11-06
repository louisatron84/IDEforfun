/**
 * Runs dataflow.py with the project's Python on a file's text (passed on
 * stdin, so unsaved edits count). Only reads the code; never runs it.
 */
import { spawn } from 'node:child_process'
import script from './dataflow.py?raw'
import type { RawFlow } from '../shared/dataflow'
import { resolvePython } from './debugAdapter'

export const DATAFLOW_SCRIPT = script

export function runDataflow(python: string, source: string, func: string, timeoutMs = 20_000): Promise<RawFlow> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, ['-X', 'utf8', '-c', DATAFLOW_SCRIPT, func], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
      })
    } catch (err) {
      resolve({ functions: [], error: String(err) })
      return
    }
    const out: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (t: string) => (stderr = (stderr + t).slice(-2000)))
    child.stdin.on('error', () => {})
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ functions: [], error: err.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve({ functions: [], error: stderr.trim() || `The data-flow reader stopped (exit code ${code})` })
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as RawFlow)
      } catch (err) {
        resolve({ functions: [], error: `Couldn't read the data flow: ${String(err)}` })
      }
    })
    child.stdin.end(source, 'utf8')
  })
}

export async function dataflow(root: string, source: string, func: string, configured?: string): Promise<RawFlow> {
  const python = await resolvePython(root, configured)
  if (!python) return { functions: [], error: 'Python was not found. Install it from python.org, or pick an interpreter (Ctrl+Shift+P → Select Python Interpreter).' }
  return runDataflow(python, source, func)
}
