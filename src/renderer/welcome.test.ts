// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { CommandRegistry } from './keymap'
import { WelcomePage } from './welcome'

function setup() {
  const page = new WelcomePage({
    commands: { keysOf: () => [], run: () => {}, get: () => undefined } as unknown as CommandRegistry,
    folder: () => null,
    recent: async () => [],
    openRecent: () => {},
    removeRecent: async () => {},
    showWhenEmpty: () => true,
    setShowWhenEmpty: () => {},
    canClose: () => false,
    close: () => {}
  })
  document.body.replaceChildren(page.el)
  return page
}

describe('Welcome page: what\'s new', () => {
  it('after an update: the release notes at the top, as text, until dismissed', () => {
    const page = setup()
    page.setWhatsNew({ version: '0.48.0', notes: '**Database:** a new panel.\n- tables from `CREATE TABLE`\n- <img src=x onerror=alert(1)>' })
    page.show()
    const card = document.querySelector('.welcome-news')!
    expect(card.querySelector('h2')!.textContent).toBe("What's new in Forge 0.48.0")
    expect(card.querySelector('strong')!.textContent).toBe('Database:')
    expect(card.querySelector('code')!.textContent).toBe('CREATE TABLE')
    expect(card.querySelectorAll('li').length).toBe(2)
    expect(card.querySelector('img')).toBeNull()
    card.querySelector<HTMLButtonElement>('.welcome-news-close')!.click()
    expect(document.querySelector('.welcome-news')).toBeNull()
  })

  it('no notes: nothing extra', () => {
    const page = setup()
    page.show()
    expect(document.querySelector('.welcome-news')).toBeNull()
  })
})
