/**
 * A dialog showing code before Forge writes it: the generated block the
 * first time, or what "Overwrite with box" would change.
 */

export interface DiffLine {
  kind: ' ' | '+' | '-'
  text: string
}

/** A line diff (longest common subsequence; blocks are small). Line endings are ignored. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const split = (t: string) => {
    const lines = t.replace(/\r\n/g, '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines
  }
  const x = split(a)
  const y = split(b)
  const n = x.length
  const m = y.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push({ kind: ' ', text: x[i++] })
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      if (i < n && lcs[i + 1][j] === lcs[i][j + 1]) out.push({ kind: '-', text: x[i++] })
      else out.push({ kind: '+', text: y[j++] })
    } else out.push({ kind: '-', text: x[i++] })
  }
  return out
}

export function showCodeDialog(opts: { title: string; code?: string; diff?: DiffLine[]; ok: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'code-dialog-overlay'
    const dlg = document.createElement('div')
    dlg.className = 'code-dialog'
    dlg.tabIndex = -1
    dlg.setAttribute('role', 'dialog')
    dlg.setAttribute('aria-label', opts.title)
    const title = document.createElement('div')
    title.className = 'code-dialog-title'
    title.textContent = opts.title
    const pre = document.createElement('pre')
    if (opts.diff) {
      for (const l of opts.diff) {
        const line = document.createElement('div')
        line.className = l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'same'
        line.textContent = `${l.kind} ${l.text}`
        pre.append(line)
      }
    } else pre.textContent = opts.code ?? ''
    const buttons = document.createElement('div')
    buttons.className = 'code-dialog-buttons'
    const done = (answer: boolean) => {
      overlay.remove()
      resolve(answer)
    }
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.dataset.action = 'cancel'
    cancel.addEventListener('click', () => done(false))
    const ok = document.createElement('button')
    ok.className = 'primary'
    ok.textContent = opts.ok
    ok.dataset.action = 'ok'
    ok.addEventListener('click', () => done(true))
    buttons.append(cancel, ok)
    dlg.append(title, pre, buttons)
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        done(false)
      }
    })
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) done(false)
    })
    overlay.append(dlg)
    document.body.append(overlay)
    ok.focus()
  })
}
