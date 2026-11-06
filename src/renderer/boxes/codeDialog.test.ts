// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { lineDiff, showCodeDialog } from './codeDialog'

describe('lineDiff', () => {
  it('marks removed and added lines, keeps the rest', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: ' ', text: 'a' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'B' },
      { kind: ' ', text: 'c' },
      { kind: '+', text: 'd' }
    ])
    expect(lineDiff('x\r\ny\r\n', 'x\ny\n').every((l) => l.kind === ' ')).toBe(true)
  })
})

describe('showCodeDialog', () => {
  it('shows the code and resolves with the button pressed', async () => {
    const shown = showCodeDialog({ title: 'Write the code?', code: 'def f():\n    pass\n', ok: 'Write code' })
    const dlg = document.querySelector('.code-dialog')!
    expect(dlg.textContent).toContain('Write the code?')
    expect(dlg.querySelector('pre')!.textContent).toContain('def f():')
    ;(dlg.querySelector('[data-action="ok"]') as HTMLButtonElement).click()
    expect(await shown).toBe(true)
    expect(document.querySelector('.code-dialog')).toBeNull()
  })

  it('a diff, cancelled with Escape', async () => {
    const shown = showCodeDialog({ title: 'Overwrite?', diff: lineDiff('a\n', 'b\n'), ok: 'Overwrite' })
    expect(document.querySelectorAll('.code-dialog .del')).toHaveLength(1)
    expect(document.querySelectorAll('.code-dialog .add')).toHaveLength(1)
    document.querySelector('.code-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(await shown).toBe(false)
  })
})
