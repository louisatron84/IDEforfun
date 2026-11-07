/**
 * Connects the tokenizer to a TextBuffer.
 *
 * To color line N we need the state at the start of line N (are we inside a
 * docstring?), which depends on every line before it. We cache those states
 * and, when the text changes at line L, throw away only the cached states
 * after L. States are computed lazily, only up to the lines being drawn.
 */
import type { Token } from './tokenizer'
import { TextBuffer } from './textBuffer'
import type { LanguageMode } from './modes'
import { mergeTokens, type SemToken } from './semantic'

export class Highlighter {
  /** states[i] = state at the start of line i. Always valid for every index it holds. */
  private states: string[] = ['']
  private current: LanguageMode
  /** From the language server: what each name is, by line (lines from an edit onwards are dropped until it answers again). */
  private semantic: Map<number, SemToken[]> | null = null

  /** `mode` is asked on every use: when it changes (the file was renamed), everything is redone. */
  constructor(private readonly buffer: TextBuffer, private readonly mode: () => LanguageMode) {
    this.current = mode()
    buffer.subscribe((change) => {
      this.invalidateFrom(change.at.line)
      // Same number of lines: only that line's colours are stale; otherwise everything after it may have moved.
      const moved = change.text.includes('\n')
      if (this.semantic) for (const line of [...this.semantic.keys()]) if (moved ? line >= change.at.line : line === change.at.line) this.semantic.delete(line)
    })
  }

  private check(): LanguageMode {
    const m = this.mode()
    if (m !== this.current) {
      this.current = m
      this.states = ['']
    }
    return m
  }

  /** How many line states are cached (for tests). */
  get cachedLines(): number {
    return this.states.length
  }

  tokensFor(line: number): Token[] {
    const mode = this.check()
    const tokens = mode.tokenize(this.buffer.getLine(line), this.stateAt(line)).tokens
    return this.semantic ? mergeTokens(tokens, this.semantic.get(line)) : tokens
  }

  /** The language server's semantic tokens for the whole file (null: none). */
  setSemantic(tokens: Map<number, SemToken[]> | null): void {
    this.semantic = tokens
  }

  /**
   * Tokens for `line` only if that's cheap (the state before it is cached),
   * else null. For the minimap: it must never make a keystroke re-tokenize
   * the rest of a big file.
   */
  tokensIfCached(line: number): Token[] | null {
    this.check()
    return line < this.states.length ? this.tokensFor(line) : null
  }

  /** Cache more line states, for at most `budgetMs`. Returns true if there's more to do. */
  warmUp(budgetMs: number, upTo = this.buffer.lineCount - 1): boolean {
    this.check()
    const end = performance.now() + budgetMs
    while (this.states.length <= upTo) {
      this.stateAt(Math.min(upTo, this.states.length + 200))
      if (performance.now() > end) break
    }
    return this.states.length <= upTo
  }

  private stateAt(line: number): string {
    while (this.states.length <= line) {
      const prev = this.states.length - 1
      this.states.push(this.current.tokenize(this.buffer.getLine(prev), this.states[prev]).endState)
    }
    return this.states[line]
  }

  /** A change on `line` can't affect the state at its start, only states after it. */
  private invalidateFrom(line: number): void {
    if (this.states.length > line + 1) this.states.length = line + 1
  }
}
