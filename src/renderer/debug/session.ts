/**
 * One debugging run of a Python file through debugpy: the startup handshake,
 * breakpoints, pausing, stepping, and reading variables. No DOM here; the
 * Debug panel and editor are driven through the hooks.
 *
 * DAP startup order (debugpy):
 *   initialize → launch (answered later) → "initialized" event →
 *   setBreakpoints per file → setExceptionBreakpoints → configurationDone → launch answered
 */
import { DapClient, type DapEvent } from './dapClient'

export type DebugState = 'idle' | 'starting' | 'running' | 'paused'

export interface StackFrame {
  id: number
  name: string
  /** null for code without a file (e.g. frozen modules). */
  path: string | null
  /** 0-based, like the editor. */
  line: number
  col: number
}

export interface Variable {
  name: string
  value: string
  type?: string
  /** > 0 when it has children (list items, attributes...) to expand. */
  ref: number
}

export interface PauseInfo {
  /** 'breakpoint', 'step', 'exception', 'pause', 'entry'... */
  reason: string
  /** For exceptions: e.g. "ZeroDivisionError: division by zero". */
  description?: string
  frames: StackFrame[]
}

export interface SessionHooks {
  send(message: unknown): void
  onState(state: DebugState): void
  onOutput(category: 'stdout' | 'stderr' | 'console', text: string): void
  onPaused(info: PauseInfo): void
  onEnded(exitCode: number | null): void
}

export interface LaunchOptions {
  program: string
  cwd: string
  breakpoints: { path: string; lines: readonly number[] }[]
}

export class DebugSession {
  readonly client: DapClient
  private _state: DebugState = 'idle'
  private threadId: number | null = null
  private exitCode: number | null = null
  private configured = false
  private initialized: Promise<void>

  constructor(private readonly hooks: SessionHooks) {
    this.client = new DapClient(hooks.send)
    this.initialized = new Promise((resolve) => {
      const off = this.client.onEvent((e) => {
        if (e.event === 'initialized') {
          off()
          resolve()
        }
      })
    })
    this.client.onEvent((e) => void this.onEvent(e))
  }

  get state(): DebugState {
    return this._state
  }

  get active(): boolean {
    return this._state !== 'idle'
  }

  /** Feed every message from the adapter. */
  handleMessage(message: unknown): void {
    this.client.handleMessage(message)
  }

  async start(opts: LaunchOptions): Promise<void> {
    this.setState('starting')
    const caps = await this.client.request('initialize', {
      clientID: 'ideforfun', clientName: 'IDEforfun', adapterID: 'debugpy', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
      supportsVariableType: true, supportsRunInTerminalRequest: false
    })
    const launch = this.client.request('launch', {
      name: 'IDEforfun', type: 'python', request: 'launch',
      program: opts.program, cwd: opts.cwd,
      console: 'internalConsole', redirectOutput: true,
      justMyCode: true, showReturnValue: true,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    })
    launch.catch(() => {}) // awaited below; avoid an "unhandled" warning if it fails early
    await Promise.race([this.initialized, launch])

    for (const f of opts.breakpoints) await this.sendBreakpoints(f.path, f.lines)
    // Pause where an exception would crash the program, so you can look around.
    const filters = (caps?.exceptionBreakpointFilters ?? []).some((f: any) => f.filter === 'uncaught') ? ['uncaught'] : []
    await this.client.request('setExceptionBreakpoints', { filters })
    await this.client.request('configurationDone')
    this.configured = true
    await launch
    if (this._state === 'starting') this.setState('running')
  }

  /** Update one file's breakpoints while running (no-op before startup is done). */
  async setBreakpoints(path: string, lines: readonly number[]): Promise<void> {
    if (!this.configured || !this.active) return
    await this.sendBreakpoints(path, lines)
  }

  private async sendBreakpoints(path: string, lines: readonly number[]): Promise<void> {
    await this.client.request('setBreakpoints', {
      source: { path },
      breakpoints: lines.map((l) => ({ line: l + 1 })),
      sourceModified: false
    })
  }

  continue(): Promise<void> {
    return this.step('continue')
  }
  stepOver(): Promise<void> {
    return this.step('next')
  }
  stepInto(): Promise<void> {
    return this.step('stepIn')
  }
  stepOut(): Promise<void> {
    return this.step('stepOut')
  }

  async pause(): Promise<void> {
    if (this._state !== 'running' || this.threadId === null) return
    await this.client.request('pause', { threadId: this.threadId })
  }

  private async step(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): Promise<void> {
    if (this._state !== 'paused' || this.threadId === null) return
    this.setState('running')
    await this.client.request(command, { threadId: this.threadId })
  }

  async scopes(frameId: number): Promise<{ name: string; ref: number; expensive: boolean }[]> {
    const res = await this.client.request('scopes', { frameId })
    return (res.scopes ?? []).map((s: any) => ({ name: s.name, ref: s.variablesReference, expensive: !!s.expensive }))
  }

  async variables(ref: number): Promise<Variable[]> {
    const res = await this.client.request('variables', { variablesReference: ref })
    return (res.variables ?? []).map((v: any) => ({ name: v.name, value: v.value, type: v.type, ref: v.variablesReference ?? 0 }))
  }

  /** Run an expression in the paused frame (Debug Console). */
  async evaluate(expression: string, frameId?: number, context: 'repl' | 'hover' = 'repl'): Promise<{ result: string; ref: number }> {
    const res = await this.client.request('evaluate', { expression, frameId, context })
    return { result: res.result ?? '', ref: res.variablesReference ?? 0 }
  }

  /** End the session: stop the program and the adapter. */
  async stop(): Promise<void> {
    if (!this.active) return
    try {
      await Promise.race([
        this.client.request('disconnect', { terminateDebuggee: true }),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
    } catch {
      // already gone
    }
    this.end()
  }

  /** The adapter process exited (or failed to start). */
  adapterExited(): void {
    this.end()
  }

  private async onEvent(e: DapEvent): Promise<void> {
    switch (e.event) {
      case 'thread':
        if (e.body?.reason === 'started' && this.threadId === null) this.threadId = e.body.threadId
        break
      case 'output': {
        const cat = e.body?.category
        if (cat === 'telemetry' || !e.body?.output) break
        this.hooks.onOutput(cat === 'stdout' || cat === 'stderr' ? cat : 'console', e.body.output)
        break
      }
      case 'stopped':
        await this.onStopped(e.body ?? {})
        break
      case 'continued':
        if (this._state === 'paused') this.setState('running')
        break
      case 'exited':
        this.exitCode = e.body?.exitCode ?? null
        break
      case 'terminated':
        this.end()
        break
    }
  }

  private async onStopped(body: any): Promise<void> {
    if (!this.active) return
    if (body.threadId !== undefined) this.threadId = body.threadId
    if (this.threadId === null) {
      const res = await this.client.request('threads')
      this.threadId = res.threads?.[0]?.id ?? null
      if (this.threadId === null) return
    }
    this.setState('paused')
    let frames: StackFrame[] = []
    let description: string | undefined = body.text ?? body.description
    try {
      const res = await this.client.request('stackTrace', { threadId: this.threadId, startFrame: 0, levels: 100 })
      frames = (res.stackFrames ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        path: f.source?.path ?? null,
        line: Math.max(0, (f.line ?? 1) - 1),
        col: Math.max(0, (f.column ?? 1) - 1)
      }))
      if (body.reason === 'exception') {
        const info = await this.client.request('exceptionInfo', { threadId: this.threadId })
        description = [info.exceptionId, info.description].filter(Boolean).join(': ') || description
      }
    } catch {
      // the program may have ended meanwhile
    }
    if (this._state !== 'paused') return
    this.hooks.onPaused({ reason: body.reason ?? 'pause', description, frames })
  }

  private end(): void {
    if (!this.active) return
    this.configured = false
    this.setState('idle')
    this.client.dispose()
    this.hooks.onEnded(this.exitCode)
  }

  private setState(state: DebugState): void {
    if (state === this._state) return
    this._state = state
    this.hooks.onState(state)
  }
}
