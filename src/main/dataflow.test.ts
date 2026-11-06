import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { runDataflow } from './dataflow'
import { buildFlow, dependencies } from '../shared/dataflow'

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

const SOURCE = [
  'import pandas as pd',
  'from forge_blocks import read_csv, filter_rows, group_by, save_csv',
  '',
  'def sales(path: str, limit=10):',
  '    """Totals by region."""',
  '    orders = read_csv(path)',
  '    paid = filter_rows(orders, "status == \'paid\'")',
  '    totals = group_by(paid, ["region"], {"amount": "sum"})',
  '    for row in totals.itertuples():',
  '        print(row.region, [x for x in range(limit)])',
  '        orders = orders.head(1)',
  '    save_csv(totals, "out.csv")',
  '    return totals',
  '',
  'class Job:',
  '    def run(self):',
  '        return 1'
].join('\n')

describe.skipIf(!python)('data flow (real Python)', () => {
  it('lists the functions in a file', async () => {
    const raw = await runDataflow(python!, SOURCE, '')
    expect(raw.functions.map((f) => f.qual)).toEqual(['sales', 'Job.run'])
    expect(raw.steps).toBeUndefined()
  })

  it('reads a function: parameters, steps with what they set, use and call', async () => {
    const raw = await runDataflow(python!, SOURCE, 'sales')
    expect(raw.params).toEqual([{ name: 'path', annotation: 'str', default: null }, { name: 'limit', annotation: null, default: '10' }])
    expect(raw.doc).toBe('Totals by region.')
    const steps = raw.steps!
    expect(steps.map((s) => `${s.kind}@${s.line}`)).toEqual(['assign@6', 'assign@7', 'assign@8', 'for@9', 'call@12', 'return@13'])
    expect(steps[1]).toMatchObject({ targets: ['paid'], uses: ['filter_rows', 'orders'] })
    expect(steps[1].call).toEqual({ name: 'filter_rows', args: [{ kw: null, text: 'orders', names: ['orders'] }, { kw: null, text: '"status == \'paid\'"', names: [] }] })
    expect(steps[3].loop).toEqual({ targets: ['row'], over: 'totals.itertuples()' })
    // The comprehension's own variable isn't a use.
    expect(steps[3].body![0].uses).toEqual(['print', 'row', 'range', 'limit'])
  })

  it('wires each use to where the value was last set (parameters, steps, loop variables)', async () => {
    const flow = buildFlow(await runDataflow(python!, SOURCE, 'sales'))!
    const wires = flow.edges.map((e) => `${e.from}→${e.to}:${e.name}`)
    expect(wires).toEqual([
      'param:path→s6:path',
      's6→s7:orders',
      's7→s8:paid',
      's8→s9:totals',
      's9→s10:row',
      'param:limit→s10:limit',
      's6→s11:orders',
      's8→s12:totals',
      's8→s13:totals'
    ])
    expect(flow.nodes.find((n) => n.id === 's10')!.parent).toBe('s9')
    expect(flow.origins.get('s7')!.get('orders')).toBe('s6')
    expect([...dependencies(flow, 's7', 'down')].sort()).toEqual(['s10', 's12', 's13', 's8', 's9'])
    expect([...dependencies(flow, 's8', 'up')].sort()).toEqual(['param:path', 's6', 's7'])
  })

  it('methods drop self; a syntax error or a missing function is reported', async () => {
    const run = buildFlow(await runDataflow(python!, SOURCE, 'Job.run'))!
    expect(run.nodes.map((n) => n.id)).toEqual(['s17'])
    expect((await runDataflow(python!, 'def (:', 'x')).error).toMatch(/SyntaxError/)
    expect((await runDataflow(python!, SOURCE, 'nope')).error).toMatch(/No function nope/)
  })
})
