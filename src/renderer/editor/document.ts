/**
 * One open file: its text, undo history, highlighting state, and where the
 * user was (cursor, selection, scroll). Each tab owns one Doc; the Editor
 * displays whichever Doc is active, so switching tabs keeps everything.
 */
import type { Position } from './textBuffer'
import { TextBuffer } from './textBuffer'
import { History } from './history'
import { Highlighter } from './highlighter'
import type { Selection } from './selection'

export class Doc {
  readonly buffer: TextBuffer
  readonly history: History
  readonly highlighter: Highlighter
  cursor: Position = { line: 0, col: 0 }
  anchor: Position = { line: 0, col: 0 }
  /** Extra cursors/selections besides the main one (multi-cursor editing). Usually empty. */
  extras: Selection[] = []
  scrollTop = 0
  scrollLeft = 0

  constructor(public path: string, text: string) {
    this.buffer = new TextBuffer(text)
    this.history = new History(this.buffer)
    this.highlighter = new Highlighter(this.buffer)
  }

  get name(): string {
    return this.path.split(/[\\/]/).pop() ?? this.path
  }

  get dirty(): boolean {
    return this.history.isDirty()
  }

  getText(): string {
    return this.buffer.getText()
  }

  markSaved(): void {
    this.history.markSaved()
  }
}
