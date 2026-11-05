import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode, looksBinary, readTextFile, writeTextFile } from './textFile'
import type { Encoding } from '../shared/encoding'

describe('decode / encode', () => {
  it('reads plain UTF-8', () => {
    expect(decode(Buffer.from('héllo ✓', 'utf8'))).toEqual({ text: 'héllo ✓', encoding: 'utf8' })
  })
  it('falls back to Latin-1 for bytes that are not valid UTF-8', () => {
    expect(decode(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({ text: 'café', encoding: 'latin1' })
  })
  it('recognises byte order marks', () => {
    expect(decode(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: 'a', encoding: 'utf8bom' })
    expect(decode(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({ text: 'a', encoding: 'utf16le' })
    expect(decode(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toEqual({ text: 'a', encoding: 'utf16be' })
  })
  it('round-trips every encoding', () => {
    for (const enc of ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'latin1'] as Encoding[]) {
      const text = enc === 'latin1' ? 'café\r\nx' : 'café ✓\r\nx'
      expect(decode(encode(text, enc))).toEqual({ text, encoding: enc })
    }
  })
  it('spots binary data', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true)
    expect(looksBinary(Buffer.from('print("hi")'))).toBe(false)
  })
})

describe('readTextFile / writeTextFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ideforfun-text-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports binary files unless forced', async () => {
    const p = join(dir, 'img.png')
    await writeFile(p, Buffer.from([0x89, 0x50, 0x00, 0x00, 0x41]))
    expect(await readTextFile(p)).toEqual({ kind: 'binary', size: 5 })
    expect((await readTextFile(p, { force: true })).kind).toBe('text')
  })
  it('opens UTF-16 files (which contain NUL bytes) as text', async () => {
    const p = join(dir, 'u16.txt')
    await writeFile(p, encode('hi', 'utf16le'))
    expect(await readTextFile(p)).toMatchObject({ kind: 'text', text: 'hi', encoding: 'utf16le' })
  })
  it('reopens with a chosen encoding', async () => {
    const p = join(dir, 'w.txt')
    await writeFile(p, Buffer.from('café', 'utf8'))
    expect(await readTextFile(p, { encoding: 'latin1' })).toMatchObject({ text: 'cafÃ©', encoding: 'latin1' })
  })
  it('writes in the requested encoding', async () => {
    const p = join(dir, 'out.txt')
    await writeTextFile(p, 'é', 'utf8bom')
    expect([...(await readFile(p))]).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa9])
  })
})
