import { describe, expect, it } from 'vitest'
import { noteBlocks, shouldShowWhatsNew } from './releaseNotes'

describe('release notes', () => {
  it('reads the Markdown the notes are written in: headings, paragraphs, lists, bold and code', () => {
    const blocks = noteBlocks([
      'Three new ways to see your program.',
      '',
      '**Database:** a new panel.',
      '- tables from `CREATE TABLE`;',
      '- foreign keys',
      '',
      '## Fixes',
      'Ctrl+J works.'
    ].join('\n'))
    expect(blocks).toEqual([
      { kind: 'p', text: [{ text: 'Three new ways to see your program.' }] },
      { kind: 'p', text: [{ text: 'Database:', bold: true }, { text: ' a new panel.' }] },
      { kind: 'ul', items: [[{ text: 'tables from ' }, { text: 'CREATE TABLE', code: true }, { text: ';' }], [{ text: 'foreign keys' }]] },
      { kind: 'h', text: [{ text: 'Fixes' }] },
      { kind: 'p', text: [{ text: 'Ctrl+J works.' }] }
    ])
  })

  it('lines of one paragraph join; HTML stays text', () => {
    expect(noteBlocks('one\ntwo <b>x</b>')).toEqual([{ kind: 'p', text: [{ text: 'one two <b>x</b>' }] }])
  })

  it('shows what\'s new once, on the first start of a newer version (not on a first install)', () => {
    expect(shouldShowWhatsNew('0.47.0', '0.48.0')).toBe(true)
    expect(shouldShowWhatsNew('0.48.0', '0.48.0')).toBe(false)
    expect(shouldShowWhatsNew(null, '0.48.0')).toBe(false)
    expect(shouldShowWhatsNew('0.49.0', '0.48.0')).toBe(false)
  })
})
