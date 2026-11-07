/**
 * Editing a pipeline (any function seen as steps, see ./dataflow.ts) as text:
 * placing a block inserts a readable call (and its import), wiring changes
 * which variable a step's input is, "for each" wraps a block in a loop.
 * Export makes a script that runs on its own (built-in blocks copied in).
 */
import { BLOCKS_FILE, builtinSource, isDataParam, type BlockInfo } from './blocks'
import type { RawStep } from './dataflow'
import { addImport } from './openapiCode'

const OUT_NAMES: Record<string, string> = {
  read: 'data', api: 'api_data', filter: 'filtered', select: 'selected', transform: 'table', group: 'grouped', merge: 'merged', save: 'saved', retry: 'result', other: 'result'
}

/** A variable name not taken yet: `filtered`, `filtered_2`... */
export function freshName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let k = 2; ; k++) if (!taken.has(`${base}_${k}`)) return `${base}_${k}`
}

/** A placeholder for a setting the block needs, from its type hint. */
export function placeholder(annotation: string | null): string {
  const a = annotation ?? ''
  if (/^(str|Optional\[str\])/.test(a)) return '""'
  if (/^(int|float)/.test(a)) return '0'
  if (/^bool/.test(a)) return 'False'
  if (/^(list|tuple|List|Sequence)/.test(a)) return '[]'
  if (/^(dict|Dict|Mapping)/.test(a)) return '{}'
  return 'None'
}

/**
 * The call for placing a block: its data inputs from `inputs` (in order),
 * settings without defaults as keyword placeholders. Returns the line (no
 * indentation) and the variable it sets.
 */
export function blockCall(block: BlockInfo, inputs: readonly string[], taken: ReadonlySet<string>): { code: string; variable: string | null } {
  const args: string[] = []
  let next = 0
  block.params.forEach((p, i) => {
    if (p.name.startsWith('*')) return
    if (isDataParam(p, i)) {
      args.push(inputs[next++] ?? placeholder(p.annotation))
      return
    }
    if (p.default === null) args.push(`${p.name}=${placeholder(p.annotation)}`)
  })
  const call = `${block.name}(${args.join(', ')})`
  if (block.kind === 'save' && !block.returns) return { code: call, variable: null }
  const variable = freshName(OUT_NAMES[block.kind] ?? 'result', taken)
  return { code: `${variable} = ${call}`, variable }
}

/** The indentation of a function's body (from its first statement, or four spaces past the def). */
export function bodyIndent(text: string, defLine: number, steps: readonly RawStep[]): string {
  const lines = text.split(/\r?\n/)
  const first = steps[0] ? lines[steps[0].line - 1] : undefined
  if (first !== undefined) return /^\s*/.exec(first)![0]
  return /^\s*/.exec(lines[defLine - 1] ?? '')![0] + '    '
}

/**
 * Insert lines into a function: after a step (its last line), or else before
 * a final `return`, or else at the end of the function.
 */
export function insertInFunction(text: string, fn: { line: number; endLine: number; steps: readonly RawStep[] }, code: string[], after?: RawStep): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const indent = bodyIndent(text, fn.line, fn.steps)
  const last = fn.steps[fn.steps.length - 1]
  let at: number
  if (after) at = after.endLine
  else if (last?.kind === 'return') at = last.line - 1
  else at = fn.endLine
  // Keep a lone docstring-only body valid: nothing to remove, lines just go after it.
  lines.splice(at, 0, ...code.map((c) => (c ? indent + c : '')))
  return lines.join(eol)
}

/** `from forge_blocks import a, b`: add a name to that import line, or add the line. */
export function importFrom(text: string, module: string, name: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const re = new RegExp(`^from\\s+${module.replace(/\./g, '\\.')}\\s+import\\s+([^()#]+?)\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (!m) continue
    const names = m[1].split(',').map((n) => n.trim()).filter(Boolean)
    if (names.includes(name) || names.includes('*')) return text
    lines[i] = `from ${module} import ${[...names, name].join(', ')}`
    return lines.join(eol)
  }
  return addImport(text, `from ${module} import ${name}`)
}

/** Rewrite a step's call with one argument changed (the statement becomes one tidy line). */
export function setArgument(text: string, step: RawStep, index: number, value: string): string {
  if (!step.call || index < 0 || index >= step.call.args.length) return text
  const args = step.call.args.map((a, i) => {
    const t = i === index ? value : a.text
    return a.kw ? `${a.kw}=${t}` : t
  })
  const call = `${step.call.name}(${args.join(', ')})`
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const indent = /^\s*/.exec(lines[step.line - 1] ?? '')![0]
  let stmt: string
  if (step.kind === 'assign' && step.targets.length) stmt = `${step.targets.join(', ')} = ${call}`
  else if (step.kind === 'return') stmt = `return ${call}`
  else stmt = call
  lines.splice(step.line - 1, step.endLine - step.line + 1, indent + stmt)
  return lines.join(eol)
}

/** "for each": run a block on every item of a list (or rows of a table), collecting the results. */
/** `overIsTable`: it's a DataFrame, so loop over its rows as dicts. */
export function forEachCode(block: BlockInfo, over: string, taken: ReadonlySet<string>, overIsTable = false): { code: string[]; variable: string } {
  const item = freshName('item', taken)
  const out = freshName(`${OUT_NAMES[block.kind] ?? 'result'}_each`, taken)
  const { code } = blockCall(block, [item], new Set([...taken, item, out]))
  const call = code.includes(' = ') ? code.slice(code.indexOf(' = ') + 3) : code
  const iter = overIsTable ? `${over}.to_dict("records")` : over
  return { code: [`${out} = []`, `for ${item} in ${iter}:`, `    ${out}.append(${call})`], variable: out }
}

/** A new, empty pipeline function (and a way to run the file). */
export function newPipeline(text: string, name: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let body = text.replace(/\s*$/, '')
  const fn = [`def ${name}():`, `    """A pipeline: add steps from the block library (Pipeline view)."""`]
  const main = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m.exec(body)
  const block = (body ? eol + eol + eol : '') + fn.join(eol) + eol
  if (main) {
    body = body.slice(0, main.index).replace(/\s*$/, '') + block + eol + eol + body.slice(main.index)
    return body + eol
  }
  return body + block + eol + eol + `if __name__ == "__main__":${eol}    ${name}()${eol}`
}

/** The project copy of a built-in block, appended to blocks.py (made if needed). */
export function copyBuiltinTo(blocksPy: string | null, name: string): string | null {
  const src = builtinSource(name)
  if (!src) return null
  const header = [
    '"""Your pipeline blocks. Functions here (or marked @block anywhere) appear in Forge\'s block library."""',
    'from forge_blocks import block',
    'import pandas as pd',
    'from typing import Any, Callable, Optional',
    ''
  ].join('\n')
  const base = blocksPy && blocksPy.trim() ? blocksPy.replace(/\s*$/, '') : header
  if (new RegExp(`^def ${name}\\(`, 'm').test(base)) return blocksPy
  const eol = (blocksPy ?? '').includes('\r\n') ? '\r\n' : '\n'
  return (base + '\n\n\n' + src).replace(/\r?\n/g, eol)
}

/** A script that runs without forge_blocks.py: the built-in blocks it imports are copied in. */
export function exportStandalone(text: string, funcName: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const mod = BLOCKS_FILE.replace(/\.py$/, '')
  const used: string[] = []
  const kept = lines.filter((l) => {
    const m = new RegExp(`^from\\s+${mod}\\s+import\\s+(.+)$`).exec(l)
    if (!m) return true
    used.push(...m[1].split(',').map((n) => n.trim()).filter((n) => n && n !== 'block'))
    return false
  })
  if (!used.length) return text
  const helpers = [
    'import json', 'import time', 'import urllib.parse', 'import urllib.request', 'from typing import Any, Callable, Optional', '', 'import pandas as pd', '',
    '',
    'def block(fn):',
    '    return fn',
    ''
  ]
  const bodies = used.map((n) => builtinSource(n)).filter((s): s is string => !!s)
  const needsRecords = bodies.some((b) => b.includes('_records_table('))
  if (needsRecords) bodies.push(builtinRecordsHelper())
  // After the file's own imports.
  let at = 0
  for (let i = 0; i < kept.length; i++) if (/^(import|from)\s/.test(kept[i])) at = i + 1
  const inserted = [`# Copied from Forge's forge_blocks.py, so this script runs on its own.`, ...helpers, '', ...bodies.join('\n\n').split('\n'), '']
  kept.splice(at, 0, ...inserted)
  let out = kept.join(eol)
  if (!/^if\s+__name__\s*==/m.test(out)) out = out.replace(/\s*$/, '') + `${eol}${eol}${eol}if __name__ == "__main__":${eol}    ${funcName}()${eol}`
  return out
}

function builtinRecordsHelper(): string {
  return [
    'def _records_table(data, records_path=None):',
    '    if records_path:',
    '        for key in records_path.split("."):',
    '            data = data[key]',
    '    elif isinstance(data, dict):',
    '        lists = [v for v in data.values() if isinstance(v, list)]',
    '        if lists:',
    '            data = max(lists, key=len)',
    '    return pd.json_normalize(data)',
    ''
  ].join('\n')
}
