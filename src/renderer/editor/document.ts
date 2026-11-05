/**
 * One open file: its text, undo history, highlighting state and folded
 * blocks. A file open in both halves of a split view is one Doc; each
 * Editor keeps its own cursor and scroll position for it.
 */
import { TextBuffer } from './textBuffer'
import { History } from './history'
import { Highlighter } from './highlighter'
import { shiftLines } from './lines'

export class Doc {
  readonly buffer: TextBuffer
  readonly history: History
  readonly highlighter: Highlighter
  /** Header lines of folded blocks (they move with edits, like breakpoints). */
  folds: number[] = []

  constructor(public path: string, text: string) {
    this.buffer = new TextBuffer(text)
    this.history = new History(this.buffer)
    this.highlighter = new Highlighter(this.buffer)
    this.buffer.subscribe((change) => {
      if (this.folds.length && change.text.includes('\n')) this.folds = shiftLines(this.folds, change)
    })
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
