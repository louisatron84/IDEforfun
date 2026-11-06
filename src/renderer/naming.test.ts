import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('the IDE is called Forge', () => {
  it.each(['src/renderer/index.html', 'src/renderer/welcome.ts', 'src/main/menu.ts', 'src/renderer/main.ts', 'src/main/index.ts'])(
    '%s shows no "IDEforfun" to the user',
    (rel) => {
      expect(read(rel)).not.toMatch(/['"`>][^'"`\n<]*IDEforfun[^'"`\n<]*['"`<]/)
    }
  )

  it('the window title is Forge', () => {
    expect(read('src/renderer/index.html')).toContain('<title>Forge</title>')
  })
})
