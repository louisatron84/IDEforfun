// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { EditBar } from './editBar'

describe('EditBar (the floating bar of Edit Layout mode)', () => {
  it('Done, Reset this task, and Add panel listing the hidden panels', () => {
    document.body.innerHTML = ''
    const hooks = { done: vi.fn(), reset: vi.fn(), add: vi.fn(), hidden: () => ['where', 'calls'], title: (id: string) => id.toUpperCase() }
    const bar = new EditBar(document.body, hooks)
    expect(bar.el.hidden).toBe(true)
    bar.show()
    expect(bar.el.hidden).toBe(false)
    const buttons = [...bar.el.querySelectorAll('button')]
    buttons.find((b) => b.textContent === 'Done')!.click()
    expect(hooks.done).toHaveBeenCalled()
    buttons.find((b) => b.textContent === 'Reset this task')!.click()
    expect(hooks.reset).toHaveBeenCalled()
    const select = bar.el.querySelector('select')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['Add panel…', 'WHERE', 'CALLS'])
    select.value = 'calls'
    select.dispatchEvent(new Event('change'))
    expect(hooks.add).toHaveBeenCalledWith('calls')
    bar.hide()
    expect(bar.el.hidden).toBe(true)
  })
})
