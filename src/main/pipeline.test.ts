/**
 * Blocks and pipeline editing, checked with a real Python: the built-in
 * blocks file is valid, every edit leaves a file that parses, and the data
 * flow reader sees the new steps wired as expected.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { BLOCKS_PY, builtinBlocks, builtinSource, isDataParam, kindOf, parseParams, projectBlocks } from '../shared/blocks'
import { blockCall, copyBuiltinTo, exportStandalone, forEachCode, freshName, importFrom, insertInFunction, newPipeline, placeholder, setArgument } from '../shared/pipelineEdit'
import { buildFlow, type RawFlow } from '../shared/dataflow'
import { runDataflow } from './dataflow'
import type { ProjectGraph } from '../shared/projectGraph'

function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'pass'], { stdio: 'ignore', timeout: 20000 })
      return cmd
    } catch {
      // try the next
    }
  }
  return null
}
const python = findPython()
const parses = (code: string) => execFileSync(python!, ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: code, stdio: ['pipe', 'ignore', 'pipe'] })

const block = (name: string) => builtinBlocks().find((b) => b.name === name)!

describe('the block library', () => {
  it('lists the built-in blocks with their parameters, return type and description', () => {
    expect(builtinBlocks().map((b) => b.name)).toEqual([
      'read_csv', 'read_json', 'call_api', 'filter_rows', 'select_columns', 'rename_columns', 'add_column', 'sort_rows',
      'group_by', 'merge', 'drop_duplicates', 'fill_missing', 'retry', 'save_csv', 'save_json'
    ])
    expect(block('group_by')).toMatchObject({ kind: 'group', returns: 'pd.DataFrame', doc: expect.stringContaining('Group the rows') })
    expect(block('group_by').params.map((p) => p.name)).toEqual(['table', 'by', 'totals'])
    expect(block('retry').params.map((p) => p.name)).toEqual(['step', '*args', 'attempts', 'wait_seconds', '**kwargs'])
  })

  it('parseParams copes with nested brackets and defaults with commas', () => {
    expect(parseParams('a: dict[str, int], b: str = "x, y", *c')).toEqual([
      { name: 'a', annotation: 'dict[str, int]', default: null },
      { name: 'b', annotation: 'str', default: '"x, y"' },
      { name: '*c', annotation: null, default: null }
    ])
  })

  it('knows which parameters take data and which are settings', () => {
    const merge = block('merge').params
    expect(merge.map((p, i) => isDataParam(p, i))).toEqual([true, true, false, false])
    expect(block('retry').params.map((p, i) => isDataParam(p, i))).toEqual([false, false, false, false, false])
    expect(isDataParam({ name: 'df', annotation: null, default: null }, 0)).toBe(true)
    expect(kindOf('load_orders')).toBe('read')
    expect(kindOf('join_tables')).toBe('merge')
  })

  it('project blocks: @block functions, and public functions in blocks.py', () => {
    const graph = {
      modules: [
        { id: 'app.steps', path: 'app/steps.py', symbols: [
          { id: 'app.steps:clean', module: 'app.steps', qual: 'clean', name: 'clean', kind: 'function', line: 3, endLine: 5, decorators: ['block'], params: [{ name: 'df', annotation: null, default: null }], returns: null, doc: 'Tidy up.' },
          { id: 'app.steps:other', module: 'app.steps', qual: 'other', name: 'other', kind: 'function', line: 7, endLine: 8, decorators: [] }
        ] },
        { id: 'blocks', path: 'blocks.py', symbols: [
          { id: 'blocks:save_report', module: 'blocks', qual: 'save_report', name: 'save_report', kind: 'function', line: 1, endLine: 2, decorators: [] },
          { id: 'blocks:_helper', module: 'blocks', qual: '_helper', name: '_helper', kind: 'function', line: 4, endLine: 5, decorators: [] }
        ] },
        { id: 'forge_blocks', path: 'forge_blocks.py', symbols: [{ id: 'forge_blocks:read_csv', module: 'forge_blocks', qual: 'read_csv', name: 'read_csv', kind: 'function', line: 1, endLine: 2, decorators: ['block'] }] }
      ]
    } as unknown as ProjectGraph
    expect(projectBlocks(graph).map((b) => `${b.module}.${b.name}:${b.kind}`)).toEqual(['app.steps.clean:transform', 'blocks.save_report:save'])
  })
})

describe('placing blocks', () => {
  it('a readable call: data inputs, then settings that have no default', () => {
    expect(blockCall(block('read_csv'), [], new Set())).toEqual({ code: 'data = read_csv(path="")', variable: 'data' })
    expect(blockCall(block('filter_rows'), ['data'], new Set(['data']))).toEqual({ code: 'filtered = filter_rows(data, condition="")', variable: 'filtered' })
    expect(blockCall(block('merge'), ['a', 'b'], new Set(['merged']))).toEqual({ code: 'merged_2 = merge(a, b, on=[])', variable: 'merged_2' })
    expect(blockCall(block('save_csv'), ['grouped'], new Set()).code).toBe('saved = save_csv(grouped, path="")')
  })
  it('names and placeholders', () => {
    expect(freshName('x', new Set(['x', 'x_2']))).toBe('x_3')
    expect(placeholder('dict[str, str]')).toBe('{}')
    expect(placeholder('Optional[str]')).toBe('""')
    expect(placeholder(null)).toBe('None')
  })
  it('importFrom adds to an existing import line', () => {
    expect(importFrom('from forge_blocks import read_csv\nx = 1\n', 'forge_blocks', 'save_csv')).toBe('from forge_blocks import read_csv, save_csv\nx = 1\n')
    expect(importFrom('from forge_blocks import read_csv\n', 'forge_blocks', 'read_csv')).toBe('from forge_blocks import read_csv\n')
    expect(importFrom('import os\n', 'forge_blocks', 'merge')).toBe('import os\nfrom forge_blocks import merge\n')
  })
  it('builtinSource is one whole function', () => {
    const src = builtinSource('group_by')!
    expect(src.startsWith('@block\ndef group_by(')).toBe(true)
    expect(src).toContain('.agg(totals)')
    expect(src).not.toContain('def merge')
    expect(builtinSource('nope')).toBeNull()
  })
})

describe.skipIf(!python)('pipeline edits (real Python)', () => {
  it('forge_blocks.py is valid Python, defining every listed block', () => {
    const names = execFileSync(python!, ['-c', 'import ast, sys; t = ast.parse(sys.stdin.read()); print(",".join(f.name for f in t.body if isinstance(f, ast.FunctionDef) and any(getattr(d, "id", "") == "block" for d in f.decorator_list)))'], { input: BLOCKS_PY, encoding: 'utf8' }).trim()
    expect(names.split(',')).toEqual(builtinBlocks().map((b) => b.name))
  })

  it('build a pipeline step by step: every version parses, and the steps are wired', async () => {
    let text = newPipeline('import os\n', 'sales')
    parses(text)
    expect(text).toContain('if __name__ == "__main__":\n    sales()')
    const read = async (): Promise<RawFlow> => runDataflow(python!, text, 'sales')
    const add = async (name: string, inputs: string[]) => {
      const raw = await read()
      const taken = new Set((raw.steps ?? []).flatMap((s) => s.targets))
      const call = blockCall(block(name), inputs, taken)
      text = importFrom(insertInFunction(text, { line: raw.line!, endLine: raw.endLine!, steps: raw.steps! }, [call.code]), 'forge_blocks', name)
      parses(text)
      return call.variable
    }
    const data = await add('read_csv', [])
    const filtered = await add('filter_rows', [data!])
    const grouped = await add('group_by', [filtered!])
    await add('save_csv', [grouped!])
    expect(text).toContain('from forge_blocks import read_csv, filter_rows, group_by, save_csv')
    const flow = buildFlow(await read())!
    expect(flow.edges.map((e) => `${e.from}→${e.to}:${e.name}`)).toEqual(['s7→s8:data', 's8→s9:filtered', 's9→s10:grouped'])

    // Rewire: save the filtered rows instead of the grouped ones.
    const raw = await read()
    text = setArgument(text, raw.steps!.find((s) => s.call?.name === 'save_csv')!, 0, 'filtered')
    parses(text)
    expect(buildFlow(await read())!.edges.map((e) => `${e.from}→${e.to}:${e.name}`)).toContain('s8→s10:filtered')

    // For each: a block run on every row.
    const raw2 = await read()
    const fe = forEachCode(block('fill_missing'), 'grouped', new Set(raw2.steps!.flatMap((s) => s.targets)), true)
    text = insertInFunction(text, { line: raw2.line!, endLine: raw2.endLine!, steps: raw2.steps! }, fe.code)
    parses(text)
    const flow2 = buildFlow(await read())!
    const loop = flow2.nodes.find((n) => n.kind === 'for')!
    expect(flow2.nodes.filter((n) => n.parent === loop.id)).toHaveLength(1)
    expect(fe.code[1]).toBe('for item in grouped.to_dict("records"):')

    // Export: runs without forge_blocks.py.
    const standalone = exportStandalone(text, 'sales')
    parses(standalone)
    expect(standalone).not.toContain('from forge_blocks import')
    expect(standalone).toContain('def group_by(')
    // Only call_api / read_json need the records helper.
    expect(standalone).not.toContain('def _records_table(')
    expect(exportStandalone('from forge_blocks import call_api\ndef p():\n    x = call_api("u")\n', 'p')).toContain('def _records_table(')
  }, 60000)

  it('a project copy of a built-in block is valid and only added once', () => {
    const first = copyBuiltinTo(null, 'filter_rows')!
    parses(first)
    expect(first).toContain('def filter_rows(')
    expect(copyBuiltinTo(first, 'filter_rows')).toBe(first)
    const second = copyBuiltinTo(first, 'merge')!
    parses(second)
    expect(second.match(/def /g)).toHaveLength(2)
  })
})
