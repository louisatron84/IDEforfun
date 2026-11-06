/**
 * Box settings: the selected API box's fields. Every committed change
 * (Enter, leaving a field, ticking a box) goes straight to the box and, once
 * its code has been written, to the code. Secrets typed here go to the
 * project's .env and nowhere else.
 */
import { envName, functionNameFor, HTTP_METHODS, moduleOfPath, newRequest, renameBox, type ApiBox, type ApiRequest, type BoxAuth, type FieldNode, type HttpMethod, type KeyValue } from '../../shared/boxes'
import { authEnv, urlArgs } from '../../shared/boxCode'
import { fieldKey, pickRecords, rowsFor } from '../../shared/apiFields'
import type { TestCallResult } from '../../shared/api'
import type { BoxController, BoxState } from './controller'

export interface BoxSettingsHooks {
  testCall(box: ApiBox, requestId: string): Promise<TestCallResult>
  /** The .env variables that have a value. */
  envNames(): Promise<string[]>
  setSecret(name: string, value: string): Promise<void>
  envIgnored(): Promise<boolean>
  ignoreEnv(): Promise<void>
  /** Show the code before it is written the first time; true = write it. */
  confirmCode(title: string, code: string): Promise<boolean>
  /** Show what Overwrite would change; true = overwrite. */
  showDiff(current: string, next: string): Promise<boolean>
  confirm(message: string): boolean
  alert(message: string): void
  /** Light the box's wire on the Graph while a test call runs. */
  liveWire(boxId: string, on: boolean): void
}

const AUTH_LABELS: [BoxAuth['kind'], string][] = [
  ['none', 'None'],
  ['header', 'API key in a header'],
  ['query', 'API key in the query'],
  ['bearer', 'Bearer token'],
  ['basic', 'User name and password (Basic)']
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Ticked keys in the order the fields appear (ticks from older responses go last). */
function orderTicks(tree: readonly FieldNode[], on: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (nodes: readonly FieldNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'object') walk(n.children)
      else if (on.has(fieldKey(n.path))) out.push(fieldKey(n.path))
    }
  }
  walk(tree)
  for (const k of on) if (!out.includes(k)) out.push(k)
  return out
}

export class BoxSettings {
  readonly body: HTMLDivElement
  private requestId: string | null = null
  private envSet = new Set<string>()
  private envIgnored = true
  private testing = new Set<string>()
  private stateToken = 0

  constructor(private readonly ctrl: BoxController, private readonly hooks: BoxSettingsHooks) {
    this.body = el('div', 'box-settings')
    ctrl.onChange(() => this.render())
    this.render()
    void this.refreshEnv()
  }

  /** Ask again which .env variables are set (after a secret was saved, or another folder opened). */
  async refreshEnv(): Promise<void> {
    const [names, ignored] = await Promise.all([this.hooks.envNames().catch(() => []), this.hooks.envIgnored().catch(() => true)])
    this.envSet = new Set(names)
    this.envIgnored = ignored
    this.render()
  }

  private box(): ApiBox | undefined {
    return this.ctrl.selected ? this.ctrl.get(this.ctrl.selected) : undefined
  }

  render(): void {
    const active = document.activeElement as HTMLElement | null
    const focusKey = active && this.body.contains(active) ? active.dataset.key : undefined
    const box = this.box()
    if (!box) {
      this.body.replaceChildren(el('div', 'box-empty', 'Select a box on the Graph, or add one from the Toolbox.'))
      return
    }
    let req = box.requests.find((r) => r.id === this.requestId)
    if (!req) {
      req = box.requests[0]
      this.requestId = req.id
    }
    this.body.replaceChildren(this.header(box), this.boxSection(box), this.requestTabs(box), this.requestSection(box, req), this.footer(box))
    if (focusKey) (this.body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) as HTMLElement | null)?.focus()
  }

  // ---------- small builders ----------

  private commit(fn: (box: ApiBox) => void): void {
    const box = this.box()
    if (box) void this.ctrl.update(box.id, fn).catch((err) => this.hooks.alert(String(err instanceof Error ? err.message : err)))
  }

  private input(key: string, value: string, apply: (v: string, box: ApiBox) => void, opts: { placeholder?: string; wide?: boolean } = {}): HTMLInputElement {
    const i = el('input', opts.wide ? 'box-input wide' : 'box-input')
    i.dataset.key = key
    i.value = value
    i.spellcheck = false
    if (opts.placeholder) i.placeholder = opts.placeholder
    i.addEventListener('change', () => this.commit((b) => apply(i.value, b)))
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') i.dispatchEvent(new Event('change', { bubbles: true }))
    })
    return i
  }

  private select<T extends string>(key: string, options: [T, string][], value: T, apply: (v: T, box: ApiBox) => void): HTMLSelectElement {
    const s = el('select', 'box-select')
    s.dataset.key = key
    for (const [v, label] of options) {
      const o = el('option', undefined, label)
      o.value = v
      s.append(o)
    }
    s.value = value
    s.addEventListener('change', () => this.commit((b) => apply(s.value as T, b)))
    return s
  }

  private row(label: string, ...controls: HTMLElement[]): HTMLElement {
    const r = el('label', 'box-row')
    r.append(el('span', 'box-label', label), ...controls)
    return r
  }

  private button(label: string, action: string, fn: () => void, cls = 'box-button'): HTMLButtonElement {
    const b = el('button', cls, label)
    b.dataset.action = action
    b.addEventListener('click', fn)
    return b
  }

  private req(box: ApiBox): ApiRequest {
    return box.requests.find((r) => r.id === this.requestId) ?? box.requests[0]
  }

  // ---------- sections ----------

  private header(box: ApiBox): HTMLElement {
    const h = el('div', 'box-header')
    const name = this.input('box.name', box.name, (v, b) => renameBox(b, v.trim() || b.name), { wide: true })
    name.classList.add('box-name')
    h.append(name, this.button('Remove box', 'remove', () => void this.removeBox(box), 'box-button quiet'))
    return h
  }

  private boxSection(box: ApiBox): HTMLElement {
    const s = el('section', 'box-section')
    s.append(el('h3', undefined, 'Box'))
    s.append(this.row('Base URL', this.input('box.baseUrl', box.baseUrl, (v, b) => (b.baseUrl = v.trim()), { placeholder: 'https://api.example.com (optional)', wide: true })))
    s.append(this.row('Auth', this.select('box.auth', AUTH_LABELS, box.auth.kind, (kind, b) => (b.auth = defaultAuth(kind, b)))))
    const a = box.auth
    if (a.kind === 'header' || a.kind === 'query') {
      s.append(this.row(a.kind === 'header' ? 'Header name' : 'Parameter name', this.input('auth.name', a.name, (v, b) => {
        if (b.auth.kind === 'header' || b.auth.kind === 'query') b.auth.name = v.trim()
      })))
    }
    const envFields: [string, string, (v: string, b: ApiBox) => void][] = []
    if (a.kind === 'header' || a.kind === 'query' || a.kind === 'bearer') {
      envFields.push([a.kind === 'bearer' ? 'Token in .env' : 'Key in .env', 'auth.env', (v, b) => { if ('env' in b.auth) b.auth.env = v.trim() }])
    }
    if (a.kind === 'basic') {
      envFields.push(['User in .env', 'auth.userEnv', (v, b) => { if (b.auth.kind === 'basic') b.auth.userEnv = v.trim() }])
      envFields.push(['Password in .env', 'auth.passEnv', (v, b) => { if (b.auth.kind === 'basic') b.auth.passEnv = v.trim() }])
    }
    const names = authEnv(box).names
    envFields.forEach(([label, key, apply], i) => {
      s.append(this.row(label, this.input(key, names[i], apply)))
      s.append(this.secretRow(names[i]))
    })
    if (a.kind !== 'none' && !this.envIgnored) {
      const warn = el('div', 'box-warn', ".env isn't in .gitignore, so your secrets could end up in git. ")
      warn.append(this.button('Add .env to .gitignore', 'ignore-env', () => void this.hooks.ignoreEnv().then(() => this.refreshEnv())))
      s.append(warn)
    }
    s.append(this.row('Code goes in', this.input('box.file', box.target.file, (v, b) => this.retarget(b, { ...b.target, file: v.trim() || b.target.file }), { wide: true }),
      this.select('box.mode', [['new', 'a new file'], ['append', 'the end of an existing file']], box.target.mode, (v, b) => this.retarget(b, { ...b.target, mode: v }))))
    return s
  }

  /** Changing where the code goes: the code already written stays where it is. */
  private retarget(b: ApiBox, target: ApiBox['target']): void {
    if (b.hash !== null && (target.file !== b.target.file || target.mode !== b.target.mode)) {
      b.hash = null
      b.detached = false
    }
    b.target = target
    b.attach = { module: moduleOfPath(target.file) }
  }

  private secretRow(name: string): HTMLElement {
    const r = el('div', 'box-secret')
    const i = el('input', 'box-input')
    i.type = 'password'
    i.dataset.key = `secret.${name}`
    i.placeholder = `value of ${name}`
    i.autocomplete = 'off'
    const save = () => {
      const value = i.value
      if (!value) return
      i.value = ''
      void this.hooks.setSecret(name, value).then(() => this.refreshEnv(), (err) => this.hooks.alert(String(err instanceof Error ? err.message : err)))
    }
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save()
    })
    const state = el('span', `box-secret-state ${this.envSet.has(name) ? 'set' : 'unset'}`, this.envSet.has(name) ? 'set in .env' : 'not set')
    r.append(i, this.button('Save to .env', `secret.${name}`, save), state)
    return r
  }

  private requestTabs(box: ApiBox): HTMLElement {
    const t = el('div', 'box-tabs')
    for (const r of box.requests) {
      const b = el('button', `box-tab${r.id === this.requestId ? ' active' : ''}`, r.name || '(unnamed)')
      b.dataset.req = r.id
      b.addEventListener('click', () => {
        this.requestId = r.id
        this.render()
      })
      t.append(b)
    }
    t.append(this.button('+ Request', 'add-request', () => {
      const id = this.box()?.id
      if (!id) return
      void this.ctrl.update(id, (b) => {
        const r = newRequest(b, `request_${b.requests.length + 1}`)
        b.requests.push(r)
        this.requestId = r.id
      })
    }, 'box-tab add'))
    return t
  }

  private requestSection(box: ApiBox, req: ApiRequest): HTMLElement {
    const s = el('section', 'box-section')
    const on = (fn: (r: ApiRequest) => void) => (b: ApiBox) => {
      const r = b.requests.find((x) => x.id === req.id)
      if (r) fn(r)
    }
    s.append(this.row('Name', this.input('req.name', req.name, (v, b) => on((r) => (r.name = v.trim() || r.name))(b))))
    s.append(this.row('Request',
      this.select('req.method', HTTP_METHODS.map((m) => [m, m] as [HttpMethod, string]), req.method, (v, b) => on((r) => (r.method = v))(b)),
      this.input('req.url', req.url, (v, b) => on((r) => (r.url = v.trim()))(b), { placeholder: box.baseUrl ? '/path/{argument}' : 'https://api.example.com/path', wide: true })))
    for (const arg of urlArgs(req.url)) {
      s.append(this.row(`Test value for ${arg}`, this.input(`arg.${arg}`, req.testArgs[arg] ?? '', (v, b) => on((r) => (r.testArgs = { ...r.testArgs, [arg]: v }))(b))))
    }
    s.append(this.kvTable('Query parameters', 'q', req.query, true, (b, fn) => on((r) => (r.query = fn(r.query)))(b)))
    s.append(this.kvTable('Headers', 'h', req.headers, false, (b, fn) => on((r) => (r.headers = fn(r.headers)))(b)))
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const body = el('textarea', 'box-body')
      body.dataset.key = 'req.body'
      body.value = req.body
      body.placeholder = '{"name": "value"}'
      body.spellcheck = false
      body.addEventListener('change', () => this.commit(on((r) => (r.body = body.value))))
      s.append(this.row('Body (JSON)', body))
    }

    // Test call
    const test = el('div', 'box-test')
    const running = this.testing.has(req.id)
    const tb = this.button(running ? 'Calling…' : '⚡ Test call', 'test', () => void this.runTest(box.id, req.id), 'box-button hot')
    tb.disabled = running
    test.append(tb)
    if (req.test) test.append(el('span', `box-result ${req.test.ok ? 'ok' : 'fail'}`, resultLine(req)))
    s.append(test)

    const choices = this.ctrl.recordChoices(box.id, req.id)
    if (choices.length > 1) {
      const sel = el('select', 'box-select')
      sel.dataset.key = 'req.records'
      for (const c of choices) {
        const o = el('option', undefined, `${c.path.length ? c.path.join('.') : 'the whole response'} (${c.count})`)
        o.value = JSON.stringify(c.path)
        sel.append(o)
      }
      sel.value = JSON.stringify(req.recordsPath ?? [])
      sel.addEventListener('change', () => void this.ctrl.setRecordsPath(box.id, req.id, JSON.parse(sel.value) as string[]))
      s.append(this.row('Records from', sel))
    }
    if (req.test?.fields?.length) s.append(this.fieldList(req))
    const preview = this.preview(req)
    if (preview) s.append(preview)

    s.append(this.row('Save to (CSV)', this.input('req.output', req.output, (v, b) => on((r) => (r.output = v.trim() || r.output))(b), { wide: true })))
    s.append(this.row('Function', this.input('req.fn', req.functionName ?? '', (v, b) => on((r) => (r.functionName = v.trim() || undefined))(b), { placeholder: functionNameFor(box, { ...req, functionName: undefined }) })))
    if (box.requests.length > 1) {
      s.append(this.button('Remove this request', 'remove-request', () => {
        if (!this.hooks.confirm(`Remove the request "${req.name}" from the ${box.name} box?`)) return
        this.commit((b) => (b.requests = b.requests.filter((r) => r.id !== req.id)))
      }, 'box-button quiet'))
    }
    return s
  }

  private kvTable(title: string, prefix: string, rows: KeyValue[], withArg: boolean, apply: (b: ApiBox, fn: (rows: KeyValue[]) => KeyValue[]) => void): HTMLElement {
    const wrap = el('div', 'box-kv')
    wrap.append(el('div', 'box-label', title))
    rows.forEach((row, i) => {
      const r = el('div', 'box-kv-row')
      const set = (patch: Partial<KeyValue>) => (b: ApiBox) => apply(b, (list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))
      r.append(
        this.input(`${prefix}.${i}.key`, row.key, (v, b) => set({ key: v.trim() })(b), { placeholder: 'name' }),
        this.input(`${prefix}.${i}.value`, row.value, (v, b) => set({ value: v })(b), { placeholder: 'value', wide: true })
      )
      if (withArg) {
        const lab = el('label', 'box-arg')
        const c = el('input')
        c.type = 'checkbox'
        c.dataset.key = `${prefix}.${i}.arg`
        c.checked = !!row.arg
        c.addEventListener('change', () => this.commit((b) => set({ arg: c.checked || undefined })(b)))
        lab.title = 'Make this a parameter of the generated function (the value becomes its default)'
        lab.append(c, document.createTextNode('argument'))
        r.append(lab)
      }
      r.append(this.button('✕', `${prefix}.${i}.remove`, () => this.commit((b) => apply(b, (list) => list.filter((_x, j) => j !== i))), 'box-button quiet'))
      wrap.append(r)
    })
    wrap.append(this.button(`+ ${withArg ? 'Parameter' : 'Header'}`, `${prefix}.add`, () => this.commit((b) => apply(b, (list) => [...list, { key: '', value: '' }])), 'box-button quiet'))
    return wrap
  }

  private fieldList(req: ApiRequest): HTMLElement {
    const box = this.box()!
    const ticked = new Set(req.ticked)
    const tree = req.test!.fields!
    const wrap = el('div', 'box-fields')
    wrap.append(el('div', 'box-label', 'Fields to save'))
    const build = (nodes: readonly FieldNode[]): HTMLElement[] => nodes.map((n) => {
      if (n.kind === 'object') {
        const d = el('details', 'box-field-group')
        d.open = n.children.some(function any(c: FieldNode): boolean {
          return c.kind === 'object' ? c.children.some(any) : ticked.has(fieldKey(c.path))
        })
        d.append(el('summary', undefined, n.name), ...build(n.children))
        return d
      }
      const lab = el('label', 'box-field')
      const c = el('input')
      c.type = 'checkbox'
      c.dataset.field = fieldKey(n.path)
      c.checked = ticked.has(fieldKey(n.path))
      c.addEventListener('change', () => {
        const next = new Set(req.ticked)
        if (c.checked) next.add(fieldKey(n.path))
        else next.delete(fieldKey(n.path))
        void this.ctrl.update(box.id, (b) => {
          const r = b.requests.find((x) => x.id === req.id)
          if (r) r.ticked = orderTicks(tree, next)
        })
      })
      lab.append(c, el('span', 'box-field-name', n.kind === 'list' ? `${n.name} [ ]` : n.name), el('span', 'box-field-sample', n.sample))
      return lab
    })
    wrap.append(...build(tree))
    return wrap
  }

  private preview(req: ApiRequest): HTMLElement | null {
    if (req.test?.sample === undefined || !req.ticked.length) return null
    const rows = rowsFor(pickRecords(req.test.sample, req.recordsPath).records.slice(0, 5), req.ticked)
    const wrap = el('div', 'box-preview')
    wrap.append(el('div', 'box-label', `Preview of ${req.output}`))
    const table = el('table')
    const head = el('tr')
    for (const c of req.ticked) head.append(el('th', undefined, c))
    table.append(head)
    for (const r of rows) {
      const tr = el('tr')
      for (const c of req.ticked) tr.append(el('td', undefined, r[c]))
      table.append(tr)
    }
    wrap.append(table)
    return wrap
  }

  private footer(box: ApiBox): HTMLElement {
    const f = el('div', 'box-footer')
    const state = el('div', 'box-state')
    f.append(state)
    const token = ++this.stateToken
    void this.ctrl.state(box.id).then((s) => {
      if (token === this.stateToken) this.fillState(state, box, s)
    })
    return f
  }

  private fillState(el_: HTMLElement, box: ApiBox, s: BoxState): void {
    const msg = (text: string) => el('span', 'box-state-text', text)
    switch (s) {
      case 'unwritten':
        el_.append(msg('No code written yet.'), this.button('Write code', 'write', () => void this.writeFirst(box), 'box-button hot'))
        break
      case 'ok':
        el_.append(msg(`Code in ${box.target.file} follows this box.`))
        break
      case 'edited':
        el_.append(msg('code edited by hand: changes here no longer update it.'),
          this.button('Overwrite with box', 'overwrite', () => void this.overwrite(box)),
          this.button('Keep my edits', 'keep', () => void this.ctrl.keepEdits(box.id)))
        break
      case 'detached':
        el_.append(msg('Keeping your edits: this box no longer updates its code.'), this.button('Re-attach (overwrite with box)', 'reattach', () => void this.overwrite(box)))
        break
      case 'missing':
        el_.append(msg(`code missing from ${box.target.file}.`), this.button('Write it again', 'write', () => void this.guard(this.ctrl.writeCode(box.id))),
          this.button('Remove box', 'remove-missing', () => void this.removeBox(box)))
        break
      case 'broken':
        el_.append(msg(`The forge:box markers for this box in ${box.target.file} are damaged (missing or repeated). Fix them, or delete the block and write it again.`))
        break
    }
    el_.dataset.state = s
  }

  // ---------- actions ----------

  private async guard(p: Promise<unknown>): Promise<void> {
    try {
      await p
    } catch (err) {
      this.hooks.alert(err instanceof Error ? err.message : String(err))
    }
  }

  private async writeFirst(box: ApiBox): Promise<void> {
    const where = box.target.mode === 'new' ? box.target.file : `the end of ${box.target.file}`
    if (!(await this.hooks.confirmCode(`Write the ${box.name} box's code to ${where}?`, this.ctrl.preview(box.id)))) return
    await this.guard(this.ctrl.writeCode(box.id))
  }

  private async overwrite(box: ApiBox): Promise<void> {
    const current = (await this.ctrl.currentBlock(box.id)) ?? ''
    if (!(await this.hooks.showDiff(current, this.ctrl.preview(box.id)))) return
    await this.guard(this.ctrl.overwrite(box.id))
  }

  private async removeBox(box: ApiBox): Promise<void> {
    if (!this.hooks.confirm(`Remove the ${box.name} box?`)) return
    const withCode = box.hash !== null && this.hooks.confirm(`Also remove its code from ${box.target.file}?\n\nCancel keeps the code.`)
    await this.guard(this.ctrl.remove(box.id, withCode))
  }

  private async runTest(boxId: string, requestId: string): Promise<void> {
    const box = this.ctrl.get(boxId)
    if (!box || this.testing.has(requestId)) return
    this.testing.add(requestId)
    this.hooks.liveWire(boxId, true)
    this.render()
    try {
      const result = await this.hooks.testCall(box, requestId).catch((err): TestCallResult => ({ ok: false, ms: 0, error: String(err instanceof Error ? err.message : err) }))
      await this.ctrl.setTest(boxId, requestId, result)
    } finally {
      this.testing.delete(requestId)
      this.hooks.liveWire(boxId, false)
      this.render()
    }
  }
}

function defaultAuth(kind: BoxAuth['kind'], box: ApiBox): BoxAuth {
  switch (kind) {
    case 'header':
      return { kind, name: 'X-Api-Key', env: envName(box.name, 'KEY') }
    case 'query':
      return { kind, name: 'api_key', env: envName(box.name, 'KEY') }
    case 'bearer':
      return { kind, env: envName(box.name, 'TOKEN') }
    case 'basic':
      return { kind, userEnv: envName(box.name, 'USER'), passEnv: envName(box.name, 'PASSWORD') }
    default:
      return { kind: 'none' }
  }
}

function resultLine(req: ApiRequest): string {
  const t = req.test!
  if (!t.ok) return `✗ ${t.error ?? 'failed'}`
  const bits = [`✓ ${[t.status, t.statusText].filter((x) => x !== undefined && x !== '').join(' ')}`.trimEnd()]
  if (t.count !== undefined) bits.push(`${t.count} item${t.count === 1 ? '' : 's'}`)
  if (t.ms !== undefined) bits.push(`${(t.ms / 1000).toFixed(1)} s`)
  return bits.join(' · ')
}
