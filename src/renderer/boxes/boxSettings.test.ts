// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ApiBox, BoxesFile } from '../../shared/boxes'
import type { TestCallResult } from '../../shared/api'
import { BoxController, type BoxFiles } from './controller'
import { BoxSettings, type BoxSettingsHooks } from './boxSettings'

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function setup(result: TestCallResult = { ok: true, status: 200, statusText: 'OK', ms: 412, json: [{ a: 1, b: { c: 'x' } }, { a: 2 }] }) {
  const files = new Map<string, string>()
  const saved: BoxesFile[] = []
  const io: BoxFiles = {
    read: async (rel) => files.get(rel) ?? null,
    write: async (rel, text) => void files.set(rel, text),
    saveBoxes: async (f) => void saved.push(JSON.parse(JSON.stringify(f))),
    note: () => {}
  }
  const ctrl = new BoxController(io)
  const secrets: [string, string][] = []
  const live: [string, boolean][] = []
  const opened: string[] = []
  const calls: ApiBox[] = []
  let confirmAnswer = true
  const hooks: BoxSettingsHooks = {
    testCall: async (box) => {
      calls.push(JSON.parse(JSON.stringify(box)))
      return result
    },
    envNames: async () => secrets.map(([n]) => n),
    setSecret: async (name, value) => void secrets.push([name, value]),
    envIgnored: async () => true,
    ignoreEnv: async () => {},
    confirmCode: async () => true,
    showDiff: async () => true,
    confirm: () => confirmAnswer,
    alert: () => {},
    liveWire: (id, on) => void live.push([id, on]),
    openFile: (rel) => void opened.push(rel)
  }
  const view = new BoxSettings(ctrl, hooks)
  document.body.replaceChildren(view.body)
  return { ctrl, view, files, saved, secrets, live, opened, calls, setConfirm: (v: boolean) => (confirmAnswer = v) }
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null
function commit(key: string, value: string) {
  const el = q<HTMLInputElement>(`[data-key="${key}"]`)!
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('Box settings', () => {
  it('says what to do when no box is selected', () => {
    setup()
    expect(document.body.textContent).toContain('Select a box on the Graph, or add one from the Toolbox')
  })

  it('a committed field updates the box and its code; typing alone does not', async () => {
    const { ctrl, files } = setup()
    const box = ctrl.add(null)
    await flush()
    commit('req.url', 'https://x.org/users')
    await flush()
    q<HTMLButtonElement>('[data-action="write"]')!.click()
    await flush()
    expect(files.get('api/api.py')).toContain('def api_data(')
    const name = q<HTMLInputElement>('[data-key="req.name"]')!
    name.value = 'users'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(ctrl.get(box.id)!.requests[0].name).toBe('data')
    name.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(files.get('api/api.py')).toContain('def api_users(')
  })

  it('test call: result line, fields with ticks, preview; unticking changes the code', async () => {
    const { ctrl, files, live } = setup()
    const box = ctrl.add(null)
    await flush()
    commit('req.url', 'https://x.org/users')
    await flush()
    q<HTMLButtonElement>('[data-action="write"]')!.click()
    await flush()
    q<HTMLButtonElement>('[data-action="test"]')!.click()
    await flush()
    expect(q('.box-result')!.textContent).toBe('✓ 200 OK · 2 items · 0.4 s')
    expect(live).toEqual([[box.id, true], [box.id, false]])
    const a = q<HTMLInputElement>('[data-field="a"]')!
    const bc = q<HTMLInputElement>('[data-field="b.c"]')!
    expect(a.checked).toBe(true)
    expect(bc.checked).toBe(false)
    expect(q('.box-preview')!.textContent).toContain('a')
    bc.checked = true
    bc.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(files.get('api/api.py')).toContain('fields = ["a", "b.c"]')
    q<HTMLInputElement>('[data-field="a"]')!.checked = false
    q<HTMLInputElement>('[data-field="a"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(files.get('api/api.py')).toContain('fields = ["b.c"]')
  })

  it('after a test call, Open CSV opens the saved file', async () => {
    const { ctrl, opened } = setup()
    ctrl.add(null)
    await flush()
    expect(q('[data-action="open-csv"]')).toBeNull()
    q<HTMLButtonElement>('[data-action="test"]')!.click()
    await flush()
    q<HTMLButtonElement>('[data-action="open-csv"]')!.click()
    expect(opened).toEqual(['api_data.csv'])
  })

  it('Test call right after typing a value uses that value', async () => {
    const { ctrl, calls } = setup()
    ctrl.add(null)
    await flush()
    commit('req.url', 'https://x.org/users/{id}')
    await flush()
    const arg = q<HTMLInputElement>('[data-key="arg.id"]')!
    arg.value = '7'
    arg.dispatchEvent(new Event('change', { bubbles: true }))
    // no waiting: the click comes straight after leaving the field
    q<HTMLButtonElement>('[data-action="test"]')!.click()
    await flush()
    expect(calls[0].requests[0].testArgs).toEqual({ id: '7' })
  })

  it('a failed test call says why', async () => {
    const { ctrl } = setup({ ok: false, ms: 5, error: 'API_TOKEN is not set: add it to .env' })
    ctrl.add(null)
    await flush()
    q<HTMLButtonElement>('[data-action="test"]')!.click()
    await flush()
    expect(q('.box-result')!.textContent).toBe('✗ API_TOKEN is not set: add it to .env')
  })

  it('typing in a field is kept when the panel redraws for another change', async () => {
    const { ctrl } = setup()
    const box = ctrl.add(null)
    await flush()
    const url = q<HTMLInputElement>('[data-key="req.url"]')!
    url.focus()
    url.value = 'https://half-typed'
    await ctrl.update(box.id, (b) => (b.baseUrl = 'https://other.org'))
    await flush()
    const again = q<HTMLInputElement>('[data-key="req.url"]')!
    expect(again.value).toBe('https://half-typed')
    expect(document.activeElement).toBe(again)
    expect(ctrl.get(box.id)!.requests[0].url).toBe('')
  })

  it('the body only shows for POST, PUT and PATCH', async () => {
    const { ctrl } = setup()
    ctrl.add(null)
    await flush()
    expect(q('[data-key="req.body"]')).toBeNull()
    commit('req.method', 'POST')
    await flush()
    expect(q('[data-key="req.body"]')).not.toBeNull()
  })

  it('hand-edited code: Keep my edits detaches', async () => {
    const { ctrl, files } = setup()
    const box = ctrl.add(null)
    await flush()
    q<HTMLButtonElement>('[data-action="write"]')!.click()
    await flush()
    files.set('api/api.py', files.get('api/api.py')!.replace('return rows', 'return rows[:1]'))
    commit('req.name', 'users')
    await flush()
    expect(q('.box-state')!.textContent).toContain('code edited by hand')
    expect(q('[data-action="overwrite"]')).not.toBeNull()
    q<HTMLButtonElement>('[data-action="keep"]')!.click()
    await flush()
    expect(ctrl.get(box.id)!.detached).toBe(true)
  })

  it('secrets go to .env, never into boxes.json', async () => {
    const { ctrl, saved, secrets } = setup()
    ctrl.add(null)
    await flush()
    commit('box.auth', 'bearer')
    await flush()
    const input = q<HTMLInputElement>('[data-key="secret.API_TOKEN"]')!
    expect(input.type).toBe('password')
    input.value = 'hunter2'
    q<HTMLButtonElement>('[data-action="secret.API_TOKEN"]')!.click()
    await flush()
    expect(secrets).toEqual([['API_TOKEN', 'hunter2']])
    expect(input.isConnected ? input.value : '').toBe('')
    expect(JSON.stringify(saved)).not.toContain('hunter2')
    expect(q('.box-secret-state')!.textContent).toBe('set in .env')
  })
})
