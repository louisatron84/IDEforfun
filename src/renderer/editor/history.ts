/**
 * Undo/redo.
 *
 * The TextBuffer reports every low-level Change (insert/delete). Each user
 * action (a keystroke, a paste, Enter...) runs inside `transact`, which
 * collects those changes into one Step. Undo applies the opposite of a
 * step's changes in reverse order; redo replays them.
 *
 * Quick consecutive typing (or deleting) is merged into one step, so Ctrl+Z
 * removes a word, not a single letter.
 */
import type { Change, Position } from './textBuffer'
import { TextBuffer, comparePositions, endOf } from './textBuffer'

/** Kinds of edit. Only 'typing' and 'delete' merge with the previous step. */
export type EditKind = 'typing' | 'delete' | 'newline' | 'paste' | 'other'

interface Step {
  id: number
  kind: EditKind
  changes: Change[]
  cursorBefore: Position
  cursorAfter: Position
  time: number
  /** Never merge more edits into this step (it was saved, or undo/redo landed on it). */
  sealed: boolean
}

const MERGE_WINDOW_MS = 1000
const MAX_STEPS = 1000

export class History {
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private collecting: Change[] | null = null
  private applying = false
  private nextId = 1
  private savedId = 0 // id of the top undo step when last saved (0 = empty stack)
  private readonly now: () => number

  constructor(private readonly buffer: TextBuffer, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
    buffer.subscribe((change) => {
      if (this.applying) return
      this.collecting?.push(change)
    })
  }

  /** Run an edit as one undoable action. `edit` returns the new cursor. */
  transact(kind: EditKind, cursorBefore: Position, edit: () => Position): Position {
    const changes: Change[] = []
    this.collecting = changes
    let cursorAfter: Position
    try {
      cursorAfter = edit()
    } finally {
      this.collecting = null
    }
    const time = this.now()
    const prev = this.undoStack[this.undoStack.length - 1]
    if (changes.length === 0) {
      // Typing a ")" that's already there just steps over it: keep the word
      // being typed in one undo step by moving its end along.
      if (kind === 'typing' && prev && !prev.sealed && prev.kind === 'typing' &&
        comparePositions(prev.cursorAfter, cursorBefore) === 0 && time - prev.time < MERGE_WINDOW_MS) {
        prev.cursorAfter = cursorAfter
        prev.time = time
      }
      return cursorAfter
    }
    const canMerge =
      prev !== undefined &&
      !prev.sealed &&
      prev.kind === kind &&
      (kind === 'typing' || kind === 'delete') &&
      comparePositions(prev.cursorAfter, cursorBefore) === 0 &&
      time - prev.time < MERGE_WINDOW_MS

    if (canMerge) {
      prev.changes.push(...changes)
      prev.cursorAfter = cursorAfter
      prev.time = time
    } else {
      this.undoStack.push({
        id: this.nextId++, kind, changes, cursorBefore, cursorAfter, time, sealed: false
      })
      if (this.undoStack.length > MAX_STEPS) this.undoStack.shift()
    }
    this.redoStack = []
    return cursorAfter
  }

  /** Undo the last step; returns where the cursor should go, or null if nothing to undo. */
  undo(): Position | null {
    const step = this.undoStack.pop()
    if (!step) return null
    this.apply(() => {
      for (let i = step.changes.length - 1; i >= 0; i--) {
        const c = step.changes[i]
        if (c.kind === 'insert') this.buffer.delete(c.at, endOf(c.at, c.text))
        else this.buffer.insert(c.at, c.text)
      }
    })
    this.redoStack.push(step)
    this.sealTop()
    return step.cursorBefore
  }

  redo(): Position | null {
    const step = this.redoStack.pop()
    if (!step) return null
    this.apply(() => {
      for (const c of step.changes) {
        if (c.kind === 'insert') this.buffer.insert(c.at, c.text)
        else this.buffer.delete(c.at, endOf(c.at, c.text))
      }
    })
    this.undoStack.push(step)
    this.sealTop()
    return step.cursorAfter
  }

  markSaved(): void {
    this.sealTop()
    this.savedId = this.undoStack[this.undoStack.length - 1]?.id ?? 0
  }

  private sealTop(): void {
    const top = this.undoStack[this.undoStack.length - 1]
    if (top) top.sealed = true
  }

  /** True if the text differs from the last saved (or opened) state. */
  isDirty(): boolean {
    return (this.undoStack[this.undoStack.length - 1]?.id ?? 0) !== this.savedId
  }

  private apply(fn: () => void): void {
    this.applying = true
    try {
      fn()
    } finally {
      this.applying = false
    }
  }
}
