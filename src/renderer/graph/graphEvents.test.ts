// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildGraph, type RawFile, type RawScan } from '../../shared/projectGraph'
import { GraphView } from './graphView'

const def = (name: string, line: number) => ({ name, qual: name, kind: 'function' as const, line, endLine: line + 1, calls: [], refs: [], decorators: [] })
const file: RawFile = {
  path: 'chat.py', module: 'chat', isPackage: false, imports: [], routes: [], http: [], env: [], lines: 20,
  defs: [{ name: '<module>', qual: '<module>', kind: 'module', line: 1, endLine: 20, calls: [], refs: [], decorators: [] }, def('send', 3), def('on_reply', 8)],
  events: [
    { kind: 'emits', event: 'reply', ref: null, def: 'send', line: 4, via: 'sio.emit' },
    { kind: 'handles', event: 'reply', ref: 'on_reply', def: 'on_reply', line: 7, via: 'sio.on' }
  ]
}
const scan: RawScan = { root: '/p', python: '3.12', truncated: false, files: [file] }

describe('Graph: Events view', () => {
  it('shows events between the code that emits them and their handlers; an event\'s details list both', async () => {
    const opened: string[] = []
    const view = new GraphView({ scan: async () => ({ graph: buildGraph(scan) }), openModule: (m, line) => void opened.push(`${m}:${line}`) })
    document.body.replaceChildren(view.el)
    await view.refresh()
    ;[...document.querySelectorAll<HTMLButtonElement>('.graph-seg button')].find((b) => b.textContent === 'Events')!.click()
    expect(document.querySelector('.gnode.k-event[data-id="event:reply"]')).not.toBeNull()
    expect(document.querySelectorAll('.gedge.k-emits').length).toBe(1)
    expect(document.querySelectorAll('.gedge.k-handles').length).toBe(1)
    view.reveal('event:reply')
    const side = document.querySelector('.graph-side')!.textContent!
    expect(side).toContain('Emitted by')
    expect(side).toContain('Handled by')
    ;[...document.querySelectorAll<HTMLElement>('.graph-side .graph-item')].find((e) => e.textContent!.includes('sio.on'))!.click()
    expect(opened).toEqual(['chat.py:6'])
  })
})
