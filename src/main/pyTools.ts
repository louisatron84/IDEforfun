/**
 * Ruff and Black, run on the editor's text (piped in, so unsaved changes
 * count): lint with fixes, format, organise imports. They run from the
 * project folder so its own configuration (pyproject.toml, ruff.toml) applies.
 * Ruff is looked for in the project's interpreter (python -m ruff), then on PATH.
 */
import { spawn } from 'node:child_process'
import type { ToolResult } from '../shared/api'

type Tool = 'ruff' | 'black'

/** How to start a tool: [command, args before the tool's own]. */
const launchers = new Map<string, [string, string[]] | null>()

function run(cmd: string, args: string[], cwd: string, input: string, timeout = 30000): Promise<{ code: number | null; stdout: string; stderr: string; failed?: boolean }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' } })
    } catch {
      resolve({ code: null, stdout: '', stderr: '', failed: true })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (t: string) => (stdout += t))
    child.stderr.on('data', (t: string) => (stderr += t))
    child.stdin.on('error', () => {})
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, failed: true })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input, 'utf8')
  })
}

/** Find how to run a tool for this interpreter (cached). */
async function launcher(python: string | null, tool: Tool, cwd: string): Promise<[string, string[]] | null> {
  const key = `${python ?? ''}|${tool}`
  if (launchers.has(key)) return launchers.get(key)!
  const options: [string, string[]][] = []
  if (python) options.push([python, ['-m', tool]])
  if (tool === 'ruff') options.push(['ruff', []])
  let found: [string, string[]] | null = null
  for (const [cmd, pre] of options) {
    const r = await run(cmd, [...pre, '--version'], cwd, '', 20000)
    if (!r.failed && r.code === 0) {
      found = [cmd, pre]
      break
    }
  }
  launchers.set(key, found)
  return found
}

/** Forget what was found (after pip installs something). */
export function forgetTools(): void {
  launchers.clear()
}

export async function toolsAvailable(python: string | null, cwd: string): Promise<{ ruff: boolean; black: boolean }> {
  const [ruff, black] = await Promise.all([launcher(python, 'ruff', cwd), launcher(python, 'black', cwd)])
  return { ruff: !!ruff, black: !!black }
}

const errorText = (r: { stderr: string; stdout: string }) =>
  (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).filter((l) => l.trim()).slice(-4).join('\n') || 'it failed'

/** `ruff check` on a file's text: the JSON list of problems (with fixes). */
export async function ruffCheck(python: string | null, cwd: string, path: string, text: string): Promise<ToolResult> {
  const l = await launcher(python, 'ruff', cwd)
  if (!l) return { ok: false, missing: true, output: '' }
  const r = await run(l[0], [...l[1], 'check', '--output-format=json', '--exit-zero', '--no-cache', '--stdin-filename', path, '-'], cwd, text)
  if (r.code !== 0) return { ok: false, output: '', error: `Ruff: ${errorText(r)}` }
  return { ok: true, output: r.stdout }
}

/** `ruff check --fix` (optionally only some rules, e.g. I and F401 to organise imports): the fixed text. */
export async function ruffFix(python: string | null, cwd: string, path: string, text: string, select?: string[]): Promise<ToolResult> {
  const l = await launcher(python, 'ruff', cwd)
  if (!l) return { ok: false, missing: true, output: '' }
  const args = [...l[1], 'check', '--fix', '--exit-zero', '--no-cache', '--quiet']
  if (select?.length) args.push('--select', select.join(','))
  args.push('--stdin-filename', path, '-')
  const r = await run(l[0], args, cwd, text)
  if (r.code !== 0) return { ok: false, output: '', error: `Ruff: ${errorText(r)}` }
  return { ok: true, output: r.stdout }
}

/**
 * Format with Ruff or Black. `lines` (1-based, inclusive) limits it to a
 * selection where the tool supports that.
 */
export async function formatText(
  python: string | null, cwd: string, path: string, text: string, tool: Tool, lines?: { from: number; to: number }
): Promise<ToolResult> {
  const l = await launcher(python, tool, cwd)
  if (!l) return { ok: false, missing: true, output: '' }
  const args = tool === 'ruff'
    ? [...l[1], 'format', '--no-cache', '--quiet', ...(lines ? [`--range=${lines.from}-${lines.to}`] : []), '--stdin-filename', path, '-']
    : [...l[1], '--quiet', ...(lines ? [`--line-ranges=${lines.from}-${lines.to}`] : []), '--stdin-filename', path, '-']
  const r = await run(l[0], args, cwd, text)
  if (r.code !== 0) {
    const msg = errorText(r)
    // Older versions don't know about formatting part of a file.
    if (lines && /range|line-ranges|unexpected argument|no such option/i.test(msg)) {
      return { ok: false, output: '', error: `This version of ${tool === 'ruff' ? 'Ruff' : 'Black'} can't format just a selection; upgrade it, or format the whole file.` }
    }
    return { ok: false, output: '', error: `${tool === 'ruff' ? 'Ruff' : 'Black'} couldn't format it: ${msg}` }
  }
  return { ok: true, output: r.stdout }
}
