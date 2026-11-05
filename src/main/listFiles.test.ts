import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles } from './listFiles'

describe('listFiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'ideforfun-'))
  mkdirSync(join(root, 'pkg', 'sub'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'main.py'), '')
  writeFileSync(join(root, 'pkg', 'a.py'), '')
  writeFileSync(join(root, 'pkg', 'sub', 'b.py'), '')
  writeFileSync(join(root, 'node_modules', 'x', 'junk.js'), '')
  writeFileSync(join(root, '.git', 'HEAD'), '')

  it('lists files recursively with relative paths, skipping hidden folders', async () => {
    const files = await listFiles(root)
    expect(files.map((f) => f.rel).sort()).toEqual(['main.py', 'pkg/a.py', 'pkg/sub/b.py'])
    expect(files.find((f) => f.rel === 'pkg/a.py')!.path).toBe(join(root, 'pkg', 'a.py'))
  })

  it('stops at the limit, shallow files first', async () => {
    const files = await listFiles(root, 2)
    expect(files.map((f) => f.rel)).toEqual(['main.py', 'pkg/a.py'])
  })
})
