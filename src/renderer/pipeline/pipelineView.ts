/**
 * The Pipeline panel: a function's data flow drawn as steps (any function;
 * a pipeline is one built from blocks). Wires show which step's data each
 * step uses, so where every variable comes from and what depends on it.
 * After "Run with data", each step shows what it produced (tables: rows,
 * columns, types and the first rows) and what it changed (rows filtered,
 * groups made, columns added). Blocks from the library are placed as
 * ordinary calls; inputs are rewired and settings edited in place; a
 * "for each" runs a block on every item; Export writes a script that runs
 * on its own.
 */
import { BLOCKS_FILE, BLOCKS_PY, BLOCKS_VERSION, isDataParam, type BlockInfo } from '../../shared/blocks'
import { buildFlow, dependencies, type Flow, type FlowNode, type RawFlow, type RawStep } from '../../shared/dataflow'
import { change, summaryText, type DataLog, type DataPoint, type Summary } from '../../shared/dataSummary'
import { blockCall, copyBuiltinTo, exportStandalone, forEachCode, importFrom, insertInFunction, newPipeline, setArgument } from '../../shared/pipelineEdit'

export interface PipelineHooks {
  /** The Python file open in the editor (project-relative, / separators), its text and module name. */
  current(): { rel: string; text: string; module: string } | null
  readFlow(text: string, func: string): Promise<RawFlow>
  read(rel: string): Promise<string | null>
  write(rel: string, text: string): Promise<unknown>
  /** Built-in and project blocks. */
  blocks(): BlockInfo[]
  openAt(rel: string, line: number): void
  runWithData(func: string): void
  ask(placeholder: string, initial: string, verb: string): Promise<string | null>
  note(message: string): void
  data: DataLog
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const SVG = 'http://www.w3.org/2000/svg'
const CONTAINERS = new Set(['for', 'if', 'while', 'with', 'try'])

export class PipelineView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly funcSelect: HTMLSelectElement
  private readonly canvas: HTMLDivElement
  private readonly cards: HTMLDivElement
  private readonly wires: SVGSVGElement
  private readonly side: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly menu: HTMLDivElement
  private rel: string | null = null
  private module = ''
  private func = ''
  private raw: RawFlow | null = null
  private flow: Flow | null = null
  private selected: string | null = null
  private hovered: string | null = null
  private loading = 0
  /** A function to show once its file is the open one (from the Graph). */
  private pendingFunc: string | null = null

  constructor(private readonly hooks: PipelineHooks) {
    this.body = el('div', 'pipeline-view')
    this.actions = el('div', 'panel-buttons')
    const bar = el('div', 'pipeline-bar')
    this.funcSelect = el('select', 'pipeline-func')
    this.funcSelect.setAttribute('aria-label', 'Function')
    this.funcSelect.addEventListener('change', () => {
      if (this.funcSelect.value === '__new') return void this.createPipeline()
      this.func = this.funcSelect.value
      this.selected = null
      void this.reload()
    })
    const button = (label: string, title: string, run: (b: HTMLButtonElement) => void, cls = '') => {
      const b = el('button', `pipeline-button ${cls}`, label)
      b.title = title
      b.addEventListener('click', () => run(b))
      return b
    }
    bar.append(
      this.funcSelect,
      button('↻', 'Read the code again', () => void this.reload()),
      button('▶ Run with data', 'Run the program and record what each step of this function produces (it must be called when the program runs)', () => this.runWithData(), 'hot'),
      button('+ Block', 'Add a step from the block library', (b) => this.showLibrary(b, false)),
      button('For each…', 'Run a block on every item of the selected step\'s result', (b) => this.showLibrary(b, true)),
      button('Export…', 'Write a script that runs without forge_blocks.py', () => void this.export())
    )
    this.status = el('div', 'pipeline-status')
    const main = el('div', 'pipeline-main')
    this.canvas = el('div', 'pipeline-canvas')
    this.wires = document.createElementNS(SVG, 'svg')
    this.wires.classList.add('pipeline-wires')
    this.cards = el('div', 'pipeline-cards')
    this.canvas.append(this.wires, this.cards)
    this.side = el('div', 'pipeline-side')
    main.append(this.canvas, this.side)
    this.menu = el('div', 'pipeline-menu')
    this.menu.hidden = true
    this.body.append(bar, this.status, main, this.menu)
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.menu.hidden = true
    })
    new ResizeObserver(() => this.drawWires()).observe(this.canvas)
    this.render()
  }

  /** Show this function's data flow (its file is being opened). */
  show(func: string): void {
    this.pendingFunc = func
    void this.refresh()
  }

  /** The open file changed (or another was opened): read it again. */
  async refresh(): Promise<void> {
    const cur = this.hooks.current()
    if (!cur) {
      this.rel = null
      this.raw = this.flow = null
      this.status.textContent = 'Open a Python file to see its functions as pipelines.'
      this.funcSelect.replaceChildren()
      return this.render()
    }
    if (cur.rel !== this.rel) {
      this.rel = cur.rel
      this.func = ''
      this.selected = null
    }
    this.module = cur.module
    await this.reload()
  }

  private async reload(): Promise<void> {
    const cur = this.hooks.current()
    if (!cur || cur.rel !== this.rel) return
    const ticket = ++this.loading
    const list = await this.hooks.readFlow(cur.text, '')
    if (ticket !== this.loading) return
    if (list.error) {
      this.status.textContent = list.error
      return
    }
    const funcs = list.functions
    if (this.pendingFunc && funcs.some((f) => f.qual === this.pendingFunc)) {
      this.func = this.pendingFunc
      this.pendingFunc = null
      this.selected = null
    }
    if (!this.func || !funcs.some((f) => f.qual === this.func)) this.func = guessPipeline(cur.text, funcs.map((f) => f.qual)) ?? ''
    this.funcSelect.replaceChildren(...funcs.map((f) => new Option(`${f.qual}()  · line ${f.line}`, f.qual)), new Option('New pipeline…', '__new'))
    this.funcSelect.value = this.func || '__new'
    if (!this.func) {
      this.raw = this.flow = null
      this.status.textContent = funcs.length ? '' : 'No functions in this file: New pipeline… makes one.'
      return this.render()
    }
    const raw = await this.hooks.readFlow(cur.text, this.func)
    if (ticket !== this.loading) return
    this.raw = raw
    this.flow = raw.error ? null : buildFlow(raw)
    this.status.textContent = raw.error ?? ''
    this.render()
  }

  /** New data arrived from a run: redraw (cheaply, on the next frame). */
  private queued = false
  dataChanged(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.render()
    })
  }

  private get funcId(): string {
    return `${this.module}:${this.func}`
  }

  private pointsOf(n: FlowNode): DataPoint[] {
    if (n.kind === 'param') return []
    const end = n.step && CONTAINERS.has(n.kind) ? n.line : n.endLine
    return this.hooks.data.between(this.funcId, n.line, end)
  }

  /** The value a node's variable holds after it ran (from the last run), if known. */
  private valueOf(nodeId: string, name: string): Summary | null {
    const n = this.flow?.nodes.find((x) => x.id === nodeId)
    if (!n) return null
    if (n.kind === 'param') {
      const call = this.hooks.data.io(this.funcId)?.calls[0]
      return call?.in[name] ?? null
    }
    return this.pointsOf(n).find((p) => p.var === name)?.summary ?? null
  }

  private render(): void {
    const flow = this.flow
    this.menu.hidden = true
    if (!flow) {
      this.cards.replaceChildren(el('div', 'pipeline-empty', this.rel ? 'Pick a function above, or make a New pipeline… and add blocks to it.' : 'Open a Python file to see its functions as pipelines.'))
      this.side.replaceChildren()
      this.wires.replaceChildren()
      return
    }
    const blocks = new Map(this.hooks.blocks().map((b) => [b.name, b]))
    const depth = (n: FlowNode): number => (n.parent ? 1 + depth(flow.nodes.find((x) => x.id === n.parent)!) : 0)
    const lit = this.hovered ?? this.selected
    const up = lit ? dependencies(flow, lit, 'up') : new Set<string>()
    const down = lit ? dependencies(flow, lit, 'down') : new Set<string>()
    const cards = flow.nodes.map((n) => {
      const card = el('div', `pl-card kind-${n.kind}${n.id === this.selected ? ' selected' : ''}${up.has(n.id) ? ' upstream' : ''}${down.has(n.id) ? ' downstream' : ''}${lit && lit !== n.id && !up.has(n.id) && !down.has(n.id) ? ' faded' : ''}`)
      card.dataset.id = n.id
      card.style.marginLeft = `${depth(n) * 26}px`
      card.tabIndex = 0
      card.addEventListener('click', () => this.select(n.id))
      card.addEventListener('mouseenter', () => this.hover(n.id))
      card.addEventListener('mouseleave', () => this.hover(null))
      card.addEventListener('dblclick', () => this.rel && n.kind !== 'param' && this.hooks.openAt(this.rel, n.line - 1))
      card.append(this.cardContent(n, blocks.get(n.call?.name ?? '')))
      return card
    })
    if (!flow.nodes.length) cards.push(el('div', 'pipeline-empty', 'This function has no steps yet: + Block adds one.'))
    this.cards.replaceChildren(...cards)
    this.renderSide(blocks)
    requestAnimationFrame(() => this.drawWires())
  }

  private cardContent(n: FlowNode, block: BlockInfo | undefined): DocumentFragment {
    const f = document.createDocumentFragment()
    const head = el('div', 'pl-head')
    if (n.kind === 'param') {
      head.append(el('span', 'pl-kind', 'input'), el('span', 'pl-title', n.label))
      const v = this.valueOf(n.id, n.sets[0])
      if (v) head.append(el('span', 'pl-value', summaryText(v)))
      f.append(head)
      return f
    }
    if (n.call && n.kind !== 'for') {
      head.append(el('span', `pl-kind kind-${block?.kind ?? 'call'}`, block ? block.kind : n.kind === 'return' ? 'return' : 'call'), el('span', 'pl-title', n.call.name))
      f.append(head)
      const args = el('div', 'pl-args')
      n.call.args.forEach((a, i) => {
        const fromData = a.names.some((name) => this.flow!.origins.get(n.id)?.has(name))
        const chip = el('button', `pl-arg${fromData ? ' data' : ''}`, a.kw ? `${a.kw} = ${a.text}` : a.text)
        chip.title = fromData ? 'Data from an earlier step: click to take it from another one' : 'A setting: click to change it'
        chip.addEventListener('click', (e) => {
          e.stopPropagation()
          if (fromData) this.rewire(n, i, chip)
          else void this.editSetting(n, i)
        })
        args.append(chip)
      })
      f.append(args)
    } else {
      head.append(el('span', 'pl-kind', n.kind === 'assign' ? 'step' : n.kind), el('span', 'pl-title pl-code', n.label))
      f.append(head)
    }
    // What it produced, from the last run with data.
    const points = this.pointsOf(n).filter((p) => n.sets.includes(p.var) || p.var === '(returned)')
    if (n.sets.length || points.length) {
      const out = el('div', 'pl-out')
      for (const name of n.sets.length ? n.sets : ['(returned)']) {
        const p = points.find((x) => x.var === name)
        const line = el('div', 'pl-out-line')
        line.append(el('span', 'pl-var', `→ ${name}`))
        if (p) {
          line.append(el('span', 'pl-value', summaryText(p.summary) + (p.n > 1 ? ` (set ${p.n}+ times)` : '')))
          const firstInput = n.call?.args.flatMap((a) => a.names).map((nm) => this.flow!.origins.get(n.id)?.get(nm) && this.valueOf(this.flow!.origins.get(n.id)!.get(nm)!, nm)).find((v) => !!v) ?? null
          const what = change(firstInput, p.summary, block?.kind ?? '')
          if (what) line.append(el('span', 'pl-change', what))
        }
        out.append(line)
      }
      f.append(out)
    }
    return f
  }

  private hover(id: string | null): void {
    if (this.hovered === id) return
    this.hovered = id
    // Only the classes change: cheaper than a full redraw.
    const flow = this.flow
    if (!flow) return
    const lit = id ?? this.selected
    const up = lit ? dependencies(flow, lit, 'up') : new Set<string>()
    const down = lit ? dependencies(flow, lit, 'down') : new Set<string>()
    for (const c of this.cards.querySelectorAll<HTMLElement>('.pl-card')) {
      const cid = c.dataset.id!
      c.classList.toggle('upstream', up.has(cid))
      c.classList.toggle('downstream', down.has(cid))
      c.classList.toggle('faded', !!lit && lit !== cid && !up.has(cid) && !down.has(cid))
    }
    for (const w of this.wires.querySelectorAll<SVGPathElement>('path')) {
      const on = !!lit && (w.dataset.from === lit || w.dataset.to === lit || (up.has(w.dataset.from!) && (up.has(w.dataset.to!) || w.dataset.to === lit)) || (down.has(w.dataset.to!) && (down.has(w.dataset.from!) || w.dataset.from === lit)))
      w.classList.toggle('lit', on)
    }
  }

  private select(id: string): void {
    this.selected = this.selected === id ? null : id
    this.render()
  }

  /** Wires in the left margin: from the step that set a value to each step that uses it, labelled with its name. */
  private drawWires(): void {
    const flow = this.flow
    if (!flow) return this.wires.replaceChildren()
    const box = this.canvas.getBoundingClientRect()
    const height = this.cards.scrollHeight
    this.wires.setAttribute('width', String(box.width))
    this.wires.setAttribute('height', String(height))
    const pos = new Map<string, { y: number; x: number; h: number }>()
    for (const c of this.cards.querySelectorAll<HTMLElement>('.pl-card')) pos.set(c.dataset.id!, { y: c.offsetTop, x: c.offsetLeft, h: c.offsetHeight })
    const parts: SVGElement[] = []
    const lanes = new Map<string, number>()
    flow.edges.forEach((e) => {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      if (!a || !b) return
      const lane = lanes.get(e.from) ?? lanes.size % 4
      lanes.set(e.from, lane)
      const y1 = a.y + a.h / 2
      const y2 = b.y + Math.min(18, b.h / 2)
      const x1 = a.x
      const x2 = b.x
      const bend = 14 + lane * 7
      const d = `M${x1},${y1} C${Math.min(x1, x2) - bend},${y1} ${Math.min(x1, x2) - bend},${y2} ${x2},${y2}`
      const path = document.createElementNS(SVG, 'path')
      path.setAttribute('d', d)
      path.dataset.from = e.from
      path.dataset.to = e.to
      const lit = this.selected && (e.from === this.selected || e.to === this.selected)
      path.setAttribute('class', `pl-wire${lit ? ' lit' : ''}`)
      const title = document.createElementNS(SVG, 'title')
      title.textContent = `${e.name}: from line ${flow.nodes.find((n) => n.id === e.from)?.line} to line ${flow.nodes.find((n) => n.id === e.to)?.line}`
      path.append(title)
      parts.push(path)
    })
    this.wires.replaceChildren(...parts)
  }

  private renderSide(blocks: Map<string, BlockInfo>): void {
    const flow = this.flow!
    const n = flow.nodes.find((x) => x.id === this.selected)
    if (!n) {
      const intro = el('div', 'pl-side-intro')
      intro.textContent = this.raw?.doc ? `${this.func}: ${this.raw.doc}` : `${this.func}()`
      const hint = el('p', 'pl-side-note', 'Each box is a step; the lines on the left carry data from the step that made it to the steps that use it. Click a step for where its data comes from and what it produced. ▶ Run with data fills in the values.')
      return void this.side.replaceChildren(intro, hint)
    }
    const out: HTMLElement[] = [el('div', 'pl-side-title', n.kind === 'param' ? `Input: ${n.label}` : `Line ${n.line}`), el('pre', 'pl-side-code', n.step?.code ?? n.label)]
    const actions = el('div', 'pl-side-actions')
    if (n.kind !== 'param' && this.rel) {
      const open = el('button', 'pipeline-button', 'Open in editor')
      open.addEventListener('click', () => this.hooks.openAt(this.rel!, n.line - 1))
      actions.append(open)
    }
    const block = blocks.get(n.call?.name ?? '')
    if (block) {
      const edit = el('button', 'pipeline-button', block.source === 'builtin' ? 'Edit block (makes a project copy)' : 'Edit block')
      edit.addEventListener('click', () => void this.editBlock(block))
      actions.append(edit)
    }
    out.push(actions)
    if (block?.doc) out.push(el('p', 'pl-side-note', block.doc))
    const origins = flow.origins.get(n.id)
    if (origins?.size) {
      out.push(el('div', 'pl-side-section', 'Where its data comes from'))
      for (const [name, from] of origins) {
        const src = flow.nodes.find((x) => x.id === from)!
        const row = el('button', 'pl-side-link', `${name} ← ${src.kind === 'param' ? 'input' : `line ${src.line}`}: ${src.label}`)
        row.addEventListener('click', () => this.select(from))
        out.push(row)
      }
    }
    const users = flow.edges.filter((e) => e.from === n.id)
    if (users.length) {
      out.push(el('div', 'pl-side-section', 'Used by'))
      for (const e of users) {
        const to = flow.nodes.find((x) => x.id === e.to)!
        const row = el('button', 'pl-side-link', `${e.name} → line ${to.line}: ${to.label}`)
        row.addEventListener('click', () => this.select(e.to))
        out.push(row)
      }
    }
    const points = n.kind === 'param' ? n.sets.map((s) => ({ var: s, n: 1, summary: this.valueOf(n.id, s) })).filter((p): p is DataPoint => !!p.summary) : this.pointsOf(n)
    if (points.length) {
      out.push(el('div', 'pl-side-section', 'Last run with data'))
      for (const p of points) out.push(previewOf(p))
    }
    this.side.replaceChildren(...out)
  }

  // ---------- editing ----------

  private async edit(fn: (text: string, raw: RawFlow) => string | null): Promise<void> {
    const cur = this.hooks.current()
    if (!cur || cur.rel !== this.rel || !this.raw?.steps) return
    // Read it fresh: the code may have changed since it was drawn.
    const raw = await this.hooks.readFlow(cur.text, this.func)
    if (!raw.steps) {
      this.status.textContent = raw.error ?? 'Couldn\'t read the function.'
      return
    }
    const next = fn(cur.text, raw)
    if (next === null || next === cur.text) return
    await this.hooks.write(cur.rel, next)
    await this.reload()
  }

  /** Variables set up to and including `after` (every step when undefined; only the parameters when null). */
  private variablesBefore(raw: RawFlow, after: RawStep | null | undefined): string[] {
    const vars: string[] = (raw.params ?? []).map((p) => p.name).filter((p) => p !== 'self' && p !== 'cls')
    if (after === null) return vars
    const walk = (steps: RawStep[]): boolean => {
      for (const s of steps) {
        for (const t of s.targets) {
          const i = vars.indexOf(t)
          if (i >= 0) vars.splice(i, 1)
          vars.push(t)
        }
        if (s === after) return true
      }
      return false
    }
    walk(raw.steps ?? [])
    return vars
  }

  private findStep(raw: RawFlow, id: string | null): RawStep | undefined {
    if (!id || !id.startsWith('s')) return undefined
    const line = Number(id.slice(1).split('_')[0])
    const find = (steps: RawStep[]): RawStep | undefined => {
      for (const s of steps) {
        if (s.line === line) return s
        const inner = s.body ? find(s.body) : undefined
        if (inner) return inner
      }
      return undefined
    }
    return find(raw.steps ?? [])
  }

  private showLibrary(anchor: HTMLElement, forEach: boolean): void {
    if (!this.flow || !this.rel) {
      this.status.textContent = 'Pick a function first (or make a New pipeline…).'
      return
    }
    if (forEach && !this.flow.nodes.find((n) => n.id === this.selected)?.sets.length) {
      this.status.textContent = 'Select the step whose result you want to go through, then For each….'
      return
    }
    const blocks = this.hooks.blocks()
    const group = (title: string, list: BlockInfo[]) => {
      if (!list.length) return []
      const items = list.map((b) => {
        const item = el('button', 'pipeline-menu-item')
        item.append(el('span', `pl-kind kind-${b.kind}`, b.kind), el('span', 'pl-title', b.name), el('span', 'pipeline-menu-doc', b.doc))
        item.title = `${b.name}(${b.params.map((p) => p.name).join(', ')})${b.returns ? ` -> ${b.returns}` : ''}`
        item.addEventListener('click', () => {
          this.menu.hidden = true
          void this.place(b, forEach)
        })
        return item
      })
      return [el('div', 'pipeline-menu-title', title), ...items]
    }
    this.menu.replaceChildren(
      el('div', 'pipeline-menu-note', forEach ? 'Run which block on every item?' : 'Add a step (after the selected one, or at the end):'),
      ...group('Built-in (pandas)', blocks.filter((b) => b.source === 'builtin')),
      ...group('Your blocks (@block, or in blocks.py)', blocks.filter((b) => b.source === 'project'))
    )
    const a = anchor.getBoundingClientRect()
    const host = this.body.getBoundingClientRect()
    this.menu.style.left = `${Math.max(4, a.left - host.left)}px`
    this.menu.style.top = `${a.bottom - host.top + 4}px`
    this.menu.hidden = false
  }

  private async place(b: BlockInfo, forEach: boolean): Promise<void> {
    const rel = this.rel!
    const selected = this.selected
    const flow = this.flow
    await this.edit((text, raw) => {
      const after = this.findStep(raw, selected)
      const fn = { line: raw.line!, endLine: raw.endLine!, steps: raw.steps! }
      const vars = this.variablesBefore(raw, after)
      const taken = new Set(this.variablesBefore(raw, undefined))
      const selectedVar = flow?.nodes.find((n) => n.id === selected)?.sets[0]
      let lines: string[]
      if (forEach) {
        const over = selectedVar ?? vars[vars.length - 1]
        const isTable = (selected && selectedVar ? this.valueOf(selected, selectedVar)?.kind === 'dataframe' : false) ||
          /DataFrame/.test(this.hooks.blocks().find((x) => x.name === flow?.nodes.find((n) => n.id === selected)?.call?.name)?.returns ?? '')
        lines = forEachCode(b, over, taken, isTable).code
      } else {
        const dataCount = b.params.filter((p, i) => isDataParam(p, i)).length
        const recent = vars.filter((v) => v !== selectedVar)
        const inputs = selectedVar ? [selectedVar, ...recent.slice(-(dataCount - 1 || 1)).reverse()] : recent.slice(-dataCount).reverse()
        lines = [blockCall(b, dataCount ? inputs.slice(0, dataCount) : [], taken).code]
      }
      let next = insertInFunction(text, fn, lines, after)
      if (b.source === 'builtin') next = importFrom(next, BLOCKS_FILE.replace(/\.py$/, ''), b.name)
      else if (b.module && b.module !== this.module) next = importFrom(next, b.module, b.name)
      return next
    })
    if (b.source === 'builtin') await this.ensureBlocksFile(rel)
    this.hooks.note(`Added ${b.name}: click its settings to fill them in.`)
  }

  /** forge_blocks.py next to the pipeline (written, or updated if Forge's copy is older). */
  private async ensureBlocksFile(rel: string): Promise<void> {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
    const path = dir + BLOCKS_FILE
    const existing = await this.hooks.read(path)
    const version = existing ? Number(/^# forge:blocks (\d+)/.exec(existing)?.[1] ?? NaN) : NaN
    if (existing === null || (Number.isFinite(version) && version < BLOCKS_VERSION)) {
      await this.hooks.write(path, BLOCKS_PY)
      this.hooks.note(`Wrote ${path} (the built-in blocks; they use pandas: pip install pandas).`)
    }
  }

  private rewire(n: FlowNode, index: number, chip: HTMLElement): void {
    if (!this.raw) return
    const step = this.findStep(this.raw, n.id)
    const flowNodes = this.flow!.nodes
    const previous = flowNodes.slice(0, flowNodes.indexOf(n)).reverse().map((x) => this.findStep(this.raw!, x.id)).find(Boolean)
    const before = this.variablesBefore(this.raw, previous ?? null)
    if (!step) return
    const pick = el('select', 'pl-rewire')
    for (const v of before) pick.append(new Option(v, v))
    pick.value = step.call?.args[index]?.text ?? ''
    pick.addEventListener('click', (e) => e.stopPropagation())
    pick.addEventListener('change', () => {
      const value = pick.value
      void this.edit((text, raw) => {
        const s = this.findStep(raw, n.id)
        return s ? setArgument(text, s, index, value) : null
      })
    })
    pick.addEventListener('blur', () => this.render())
    chip.replaceWith(pick)
    pick.focus()
  }

  private async editSetting(n: FlowNode, index: number): Promise<void> {
    const arg = n.call?.args[index]
    if (!arg) return
    const value = await this.hooks.ask(`${n.call!.name}: ${arg.kw ?? `argument ${index + 1}`} (Python, e.g. "text", 10, ["a", "b"])`, arg.text, 'Set')
    if (value === null || value.trim() === '' || value === arg.text) return
    await this.edit((text, raw) => {
      const s = this.findStep(raw, n.id)
      return s ? setArgument(text, s, index, value.trim()) : null
    })
  }

  private async editBlock(b: BlockInfo): Promise<void> {
    if (b.source === 'project' && b.path) return this.hooks.openAt(b.path, (b.line ?? 1) - 1)
    const rel = this.rel
    if (!rel) return
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
    const blocksRel = `${dir}blocks.py`
    const existing = await this.hooks.read(blocksRel)
    const copy = copyBuiltinTo(existing, b.name)
    if (!copy) return
    if (copy !== existing) await this.hooks.write(blocksRel, copy)
    // The pipeline now uses the project copy.
    await this.edit((text) => importFrom(moveFromImport(text, BLOCKS_FILE.replace(/\.py$/, ''), b.name), 'blocks', b.name))
    const line = copy.split(/\r?\n/).findIndex((l) => l.startsWith(`def ${b.name}(`))
    this.hooks.note(`${b.name} is now your copy in ${blocksRel}: edit it there.`)
    this.hooks.openAt(blocksRel, Math.max(0, line))
  }

  private async createPipeline(): Promise<void> {
    const name = await this.hooks.ask('Name of the new pipeline function (e.g. sales_report)', 'pipeline', 'Create')
    this.funcSelect.value = this.func || ''
    if (!name) return
    const py = name.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')
    const cur = this.hooks.current()
    if (!cur) return
    await this.hooks.write(cur.rel, newPipeline(cur.text, py))
    this.func = py
    await this.reload()
  }

  private runWithData(): void {
    if (!this.func) {
      this.status.textContent = 'Pick a function first.'
      return
    }
    this.status.textContent = `Running: the first call of ${this.func}() is recorded step by step.`
    this.hooks.runWithData(this.funcId)
  }

  private async export(): Promise<void> {
    const cur = this.hooks.current()
    if (!cur || !this.func) return
    const standalone = exportStandalone(cur.text, this.func)
    if (standalone === cur.text) {
      this.hooks.note('This file doesn\'t use the built-in blocks: it already runs on its own.')
      return
    }
    const target = await this.hooks.ask('Save the standalone script as', cur.rel.replace(/\.py$/, '_standalone.py'), 'Export')
    if (!target) return
    await this.hooks.write(target.trim().replace(/\\/g, '/'), standalone)
    this.hooks.note(`Exported ${target}: it runs without forge_blocks.py (pandas is still needed).`)
  }
}

/** Remove a name from `from module import a, b` (the whole line if it was the only one). */
export function moveFromImport(text: string, module: string, name: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const re = new RegExp(`^from\\s+${module.replace(/\./g, '\\.')}\\s+import\\s+(.+)$`)
  const lines: string[] = []
  for (const l of text.split(/\r?\n/)) {
    const m = re.exec(l)
    if (!m) {
      lines.push(l)
      continue
    }
    const rest = m[1].split(',').map((x) => x.trim()).filter((x) => x && x !== name)
    if (rest.length) lines.push(`from ${module} import ${rest.join(', ')}`)
  }
  return lines.join(eol)
}

/** The function to show first: one named like a pipeline, else one that uses blocks, else the first. */
export function guessPipeline(text: string, funcs: string[]): string | null {
  const top = funcs.filter((f) => !f.includes('.'))
  return top.find((f) => /pipeline|etl|report|process/i.test(f)) ?? (/forge_blocks|@block/.test(text) ? top[top.length - 1] : undefined) ?? funcs[0] ?? null
}

/** A value from the last run: its description, and a small table for tables and lists of records. */
function previewOf(p: DataPoint): HTMLElement {
  const box = el('div', 'pl-preview')
  box.append(el('div', 'pl-preview-head', `${p.var}: ${summaryText(p.summary)}`))
  const s = p.summary
  if (s.columns?.length && s.rows) {
    const table = el('table')
    const head = el('tr')
    if (s.index) head.append(el('th', 'pl-index', ''))
    for (const [c, t] of s.columns) {
      const th = el('th', '', c)
      if (t) th.append(el('span', 'pl-dtype', t))
      head.append(th)
    }
    table.append(head)
    s.rows.forEach((r, i) => {
      const tr = el('tr')
      if (s.index) tr.append(el('td', 'pl-index', s.index[i] ?? ''))
      for (const c of r) tr.append(el('td', '', c))
      table.append(tr)
    })
    const wrap = el('div', 'pl-table')
    wrap.append(table)
    box.append(wrap)
    if ((s.shape?.[0] ?? s.len ?? 0) > s.rows.length) box.append(el('div', 'pl-side-note', `First ${s.rows.length} rows`))
  } else if (s.kind === 'series' && s.rows) {
    box.append(el('pre', 'pl-side-code', s.rows.map((r) => r.join('  ')).join('\n')))
  } else if (s.sample?.length) {
    box.append(el('pre', 'pl-side-code', s.sample.map((x) => (Array.isArray(x) ? `${x[0]}: ${x[1]}` : x)).join('\n')))
  } else if (s.repr) box.append(el('pre', 'pl-side-code', s.repr))
  return box
}
