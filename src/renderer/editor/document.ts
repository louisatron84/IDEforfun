/**
 * One open file: its text, undo history, highlighting state, folded blocks,
 * encoding and line endings. A file open in both halves of a split view is
 * one Doc; each Editor keeps its own cursor and scroll position for it.
 */
import { TextBuffer } from './textBuffer'
import { History } from './history'
import { Highlighter } from './highlighter'
import { shiftLines } from './lines'
import type { Encoding } from '../../shared/encoding'

export class Doc {
  readonly buffer: TextBuffer
  readonly history: History
  readonly highlighter: Highlighter
  /** Header lines of folded blocks (they move with edits, like breakpoints). */
  folds: number[] = []
  /** The file's encoding on disk (changing it makes the file "unsaved" until saved). */
  encoding: Encoding
  /** Big file: the language server is skipped for it to stay responsive. */
  readonly large: boolean
  private savedEncoding: Encoding
  private savedEol: '\n' | '\r\n'

  constructor(public path: string, text: string, opts: { encoding?: Encoding; large?: boolean } = {}) {
    this.buffer = new TextBuffer(text)
    this.history = new History(this.buffer)
    this.highlighter = new Highlighter(this.buffer)
    this.encoding = this.savedEncoding = opts.encoding ?? 'utf8'
    this.large = opts.large ?? false
    this.savedEol = this.buffer.eol
    this.buffer.subscribe((change) => {
      if (this.folds.length && change.text.includes('\n')) this.folds = shiftLines(this.folds, change)
    })
  }

  get name(): string {
    return this.path.split(/[\\/]/).pop() ?? this.path
  }

  /** Line endings used when saving: 'LF' (\n) or 'CRLF' (\r\n). */
  get eol(): 'LF' | 'CRLF' {
    return this.buffer.eol === '\r\n' ? 'CRLF' : 'LF'
  }

  set eol(value: 'LF' | 'CRLF') {
    this.buffer.eol = value === 'CRLF' ? '\r\n' : '\n'
  }

  get dirty(): boolean {
    return this.history.isDirty() || this.encoding !== this.savedEncoding || this.buffer.eol !== this.savedEol
  }

  getText(): string {
    return this.buffer.getText()
  }

  markSaved(): void {
    this.history.markSaved()
    this.savedEncoding = this.encoding
    this.savedEol = this.buffer.eol
  }
}
