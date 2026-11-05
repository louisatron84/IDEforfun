/**
 * Connects the tokenizer to a TextBuffer.
 *
 * To color line N we need the state at the start of line N (are we inside a
 * docstring?), which depends on every line before it. We cache those states
 * and, when the text changes at line L, throw away only the cached states
 * after L. States are computed lazily, only up to the lines being drawn.
 */
import type { Token, LineState } from './tokenizer'
import { tokenizeLine } from './tokenizer'
import { TextBuffer } from './textBuffer'

export class Highlighter {
  /** states[i] = state at the start of line i. Always valid for every index it holds. */
  private states: LineState[] = ['']

  constructor(private readonly buffer: TextBuffer) {
    buffer.subscribe((change) => this.invalidateFrom(change.at.line))
  }

  /** How many line states are cached (for tests). */
  get cachedLines(): number {
    return this.states.length
  }

  tokensFor(line: number): Token[] {
    return tokenizeLine(this.buffer.getLine(line), this.stateAt(line)).tokens
  }

  private stateAt(line: number): LineState {
    while (this.states.length <= line) {
      const prev = this.states.length - 1
      this.states.push(tokenizeLine(this.buffer.getLine(prev), this.states[prev]).endState)
    }
    return this.states[line]
  }

  /** A change on `line` can't affect the state at its start, only states after it. */
  private invalidateFrom(line: number): void {
    if (this.states.length > line + 1) this.states.length = line + 1
  }
}
