/**
 * What the Graph shows while debugging, as DOM: the paused function's
 * variables in a card beside its node (objects open in place, so there's no
 * need to go to the Debug panel), and in the side panel the history of a
 * function's variables across pauses, with a comparison of any two pauses.
 */
import type { Variable } from '../debug/session'
import { diffVars, type DebugTrail, type Stop } from './debugTrail'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** debugpy's grouping rows ("special variables"...), not real variables. */
export const GROUP_ROWS = new Set(['special variables', 'function variables', 'class variables', 'protected variables'])

export const shortValue = (v: string, max = 60): string => (v.length > max ? v.slice(0, max - 1) + '…' : v)

/** The card beside the paused node. */
export function valueCard(opts: {
  title: string
  vars: Variable[]
  expand(ref: number): Promise<Variable[]>
  actions: { label: string; title: string; run(): void }[]
}): HTMLElement {
  const card = el('div', 'graph-debug-card')
  const head = el('div', 'graph-debug-card-head')
  head.append(el('span', '', opts.title))
  for (const a of opts.actions) {
    const b = el('button', 'graph-debug-card-action', a.label)
    b.title = a.title
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      a.run()
    })
    head.append(b)
  }
  card.append(head)
  const list = el('div', 'graph-debug-vars')
  const vars = opts.vars.filter((v) => !GROUP_ROWS.has(v.name))
  if (!vars.length) list.append(el('div', 'graph-debug-empty', 'No local variables'))
  for (const v of vars.slice(0, 12)) list.append(varRow(v, opts.expand, 0))
  if (vars.length > 12) list.append(el('div', 'graph-debug-empty', `…and ${vars.length - 12} more (Debug panel)`))
  card.append(list)
  // Clicks and wheel inside the card shouldn't pan or zoom the graph.
  for (const ev of ['pointerdown', 'wheel', 'dblclick']) card.addEventListener(ev, (e) => e.stopPropagation())
  return card
}

function varRow(v: Variable, expand: (ref: number) => Promise<Variable[]>, depth: number): HTMLElement {
  const wrap = el('div', 'graph-debug-var')
  const row = el('div', 'graph-debug-var-row')
  row.style.paddingLeft = `${depth * 12}px`
  const twisty = el('button', 'graph-debug-twisty', v.ref > 0 && depth < 4 ? '▸' : '')
  twisty.disabled = !(v.ref > 0 && depth < 4)
  twisty.setAttribute('aria-label', `Open ${v.name}`)
  row.append(twisty, el('span', 'graph-debug-name', v.name), el('span', 'graph-debug-eq', '='), el('span', 'graph-debug-value', shortValue(v.value)))
  row.title = `${v.name}${v.type ? ` (${v.type})` : ''} = ${v.value}`
  wrap.append(row)
  if (!twisty.disabled) {
    let kids: HTMLElement | null = null
    twisty.addEventListener('click', async () => {
      if (kids) {
        kids.remove()
        kids = null
        twisty.textContent = '▸'
        return
      }
      twisty.textContent = '▾'
      kids = el('div')
      wrap.append(kids)
      const box = kids
      try {
        const children = (await expand(v.ref)).filter((c) => !GROUP_ROWS.has(c.name))
        if (box !== kids) return
        for (const c of children.slice(0, 50)) box.append(varRow(c, expand, depth + 1))
        if (!children.length) box.append(el('div', 'graph-debug-empty', 'empty'))
      } catch {
        box.append(el('div', 'graph-debug-empty', 'The program is running again'))
      }
    })
  }
  return wrap
}

/** A function's variables at each pause in it, with changes marked; then "compare two pauses". */
export function historyView(trail: DebugTrail, node: string): HTMLElement | null {
  const h = trail.history(node)
  if (!h.stops.length) return null
  const wrap = el('div', 'graph-debug-history')
  const table = el('table')
  const head = el('tr')
  head.append(el('th', '', 'Variable'))
  for (const n of h.stops.slice(-8)) head.append(el('th', '', `#${n}`))
  table.append(head)
  const from = Math.max(0, h.stops.length - 8)
  for (const r of h.rows) {
    const tr = el('tr')
    tr.append(el('td', 'graph-debug-name', r.name))
    for (let i = from; i < r.values.length; i++) {
      const v = r.values[i]
      const td = el('td', r.changed[i] ? 'changed' : '', v === null ? '—' : shortValue(v, 24))
      if (v !== null) td.title = v
      tr.append(td)
    }
    table.append(tr)
  }
  wrap.append(el('div', 'graph-debug-note', `Its variables at each pause in it (#n is the pause number; changed values are marked).${h.stops.length > 8 ? ' The last 8 pauses.' : ''}`), table)
  wrap.append(compareControl(trail, h.stops))
  return wrap
}

function compareControl(trail: DebugTrail, defaults: number[]): HTMLElement {
  const box = el('div', 'graph-debug-compare')
  const all = trail.stops
  if (all.length < 2) return box
  const pick = (initial: number) => {
    const s = el('select')
    for (const st of all) s.append(new Option(`#${st.n} (${st.reason}${st.stack[0] ? `, ${st.stack[0].replace(/^module:/, '').replace(':', '.')}` : ''})`, String(st.n)))
    s.value = String(initial)
    return s
  }
  const a = pick(defaults.length >= 2 ? defaults[defaults.length - 2] : all[all.length - 2].n)
  const b = pick(defaults[defaults.length - 1] ?? all[all.length - 1].n)
  const out = el('div')
  const show = () => {
    const x = trail.stop(Number(a.value))
    const y = trail.stop(Number(b.value))
    out.replaceChildren(x && y ? compareStops(x, y) : el('div', 'graph-debug-empty', 'Pick two pauses'))
  }
  a.addEventListener('change', show)
  b.addEventListener('change', show)
  const line = el('div', 'graph-debug-compare-line')
  line.append(document.createTextNode('Compare pause '), a, document.createTextNode(' with '), b)
  box.append(line, out)
  show()
  return box
}

export function compareStops(a: Stop, b: Stop): HTMLElement {
  const d = diffVars(a.vars, b.vars)
  const list = el('div', 'graph-debug-diff')
  if (a.stack[0] !== b.stack[0]) list.append(el('div', 'graph-debug-note', `Different places: ${a.stack[0] ?? '?'} and ${b.stack[0] ?? '?'}. Variables with the same name are compared.`))
  const row = (cls: string, name: string, text: string) => {
    const r = el('div', `graph-debug-diff-row ${cls}`)
    r.append(el('span', 'graph-debug-name', name), el('span', 'graph-debug-value', text))
    list.append(r)
  }
  for (const k of d.changed) row('changed', k, `${shortValue(a.vars[k], 40)} → ${shortValue(b.vars[k], 40)}`)
  for (const k of d.added) row('added', k, `new: ${shortValue(b.vars[k], 50)}`)
  for (const k of d.removed) row('removed', k, `gone (was ${shortValue(a.vars[k], 40)})`)
  if (!d.changed.length && !d.added.length && !d.removed.length) list.append(el('div', 'graph-debug-empty', 'No differences'))
  else if (d.same.length) list.append(el('div', 'graph-debug-empty', `${d.same.length} unchanged`))
  return list
}
