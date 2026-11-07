// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildGraph, type RawFile, type RawScan } from '../../shared/projectGraph'
import { parseProf } from '../../shared/profile'
import { GraphView } from './graphView'

const def = (name: string, calls: string[] = []) => ({ name, qual: name, kind: 'function' as const, line: 1, endLine: 2, calls: calls.map((c) => ({ name: c, line: 2 })), refs: [], decorators: [] })
const file = (path: string, defs: ReturnType<typeof def>[]): RawFile => ({
  path, module: path.replace(/\.py$/, ''), isPackage: false, imports: [], routes: [], http: [], env: [], lines: 10,
  defs: [{ name: '<module>', qual: '<module>', kind: 'module', line: 1, endLine: 10, calls: [], refs: [], decorators: [] }, ...defs]
})
const scan: RawScan = { root: '/p', python: '3.12', truncated: false, files: [file('app.py', [def('main', ['load', 'quick']), def('load'), def('quick')])] }

const prof = parseProf({
  t: 'prof',
  fns: [['module:app', 1, 300, 1], ['app:main', 1, 299, 4], ['app:load', 3, 290, 290], ['app:quick', 9, 5, 5]],
  edges: [['module:app', 'app:main', 299], ['app:main', 'app:load', 290], ['app:main', 'app:quick', 5]]
})!

async function setup() {
  const view = new GraphView({ scan: async () => ({ graph: buildGraph(scan) }), openModule: () => {} })
  document.body.replaceChildren(view.el)
  await view.refresh()
  return view
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.graph-seg button')].find((b) => b.textContent === text)!
const node = (id: string) => document.querySelector(`.gnode[data-id="${id}"]`)!

describe('Graph: times from the last run', () => {
  it('puts each function\'s time on it and heats the slow ones', async () => {
    const view = await setup()
    button('Calls').click()
    view.setProfile(prof)
    expect(node('app:load').querySelector('.gtime-text')!.textContent).toBe('290 ms')
    expect(node('app:load').classList.contains('hot-3')).toBe(true)
    expect(node('app:quick').className).not.toMatch(/hot-/)
    expect(node('app:main').className).not.toMatch(/hot-/)
  })

  it('in the Modules view, the time spent in each file', async () => {
    const view = await setup()
    view.setProfile(prof)
    expect(node('app').querySelector('.gtime-text')!.textContent).toBe('300 ms')
  })

  it('lists the slowest functions, and a function\'s details say where its time comes from', async () => {
    const view = await setup()
    view.setProfile(prof)
    expect(document.querySelector('.graph-side')!.textContent).toContain('Slowest in the last run')
    button('Calls').click()
    view.reveal('app:load')
    const side = document.querySelector('.graph-side')!.textContent!
    expect(side).toContain('290 ms in total, 290 ms in its own code, 3 calls')
    expect([...document.querySelectorAll('.graph-time-path .graph-item-text')].map((e) => e.textContent)).toEqual(['app (top level)', 'app.main', 'app.load'])
  })

  it('a new run clears the old times', async () => {
    const view = await setup()
    view.setProfile(prof)
    view.setProfile(null)
    expect(document.querySelector('.gtime')).toBeNull()
  })
})
