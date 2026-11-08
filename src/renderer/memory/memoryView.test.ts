// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { MemoryLog, parseMem } from '../../shared/memory'
import { MemoryView } from './memoryView'

function setup() {
  const log = new MemoryLog()
  const calls: string[] = []
  const view = new MemoryView(log, {
    run: () => void calls.push('run'),
    describe: (path, line) => (path === 'app.py' && line === 6 ? 'app.Item.__init__' : null),
    openAt: (path, line) => void calls.push(`${path}:${line}`)
  })
  document.body.replaceChildren(view.el)
  return { log, view, calls }
}
const text = () => document.body.textContent!

describe('Memory panel', () => {
  it('before a run: what it does, and a button to start one', () => {
    const { calls } = setup()
    expect(text()).toContain('slower')
    document.querySelector<HTMLButtonElement>('[data-action="run-memory"]')!.click()
    expect(calls).toEqual(['run'])
  })

  it('a run: use over time, the lines that allocate (by function), classes, and what keeps objects alive', () => {
    const { log, view, calls } = setup()
    log.begin(1)
    for (const [t, item] of [[0.5, 100], [2.5, 900], [4.5, 2000]]) {
      log.add(parseMem({ t: 'mem', peak: 3_000_000, samples: [[t, item * 1000]], sites: [['app.py', 6, 900_000, 2000], ['app.py', 12, 50_000, 30]], types: [['app.Item', item]] })!)
    }
    log.add(parseMem({ t: 'mem', peak: 3_000_000, samples: [[5, 2_000_000]], final: true, kept: [{ type: 'app.Item', count: 2000, path: ['app.CACHE', 'list'] }] })!)
    view.update()
    expect(document.querySelectorAll('.mem-chart polyline').length).toBe(1)
    expect(text()).toContain('Peak 2.9 MB')
    const site = document.querySelector<HTMLElement>('.mem-site')!
    expect(site.textContent).toContain('app.Item.__init__')
    expect(site.textContent).toContain('app.py:6')
    expect(site.textContent).toContain('878.9 KB')
    site.click()
    expect(calls).toEqual(['app.py:5'])
    expect(document.querySelector('.mem-type')!.textContent).toContain('growing')
    expect(document.querySelector('.mem-kept')!.textContent).toContain('2000 app.Item, kept by app.CACHE → list')
  })
})
