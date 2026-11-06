/**
 * One debugging run of a Python file through debugpy: the startup handshake,
 * breakpoints, pausing, stepping, and reading variables. No DOM here; the
 * Debug panel and editor are driven through the hooks.
 *
 * DAP startup order (debugpy):
 *   initialize → launch (answered later) → "initialized" event →
 *   setBreakpoints per file → setExceptionBreakpoints → configurationDone → launch answered
 *
 * Child processes: when the program starts one (multiprocessing, subprocess),
 * debugpy sends a `debugpyAttach` event (or, newer versions, a `startDebugging`
 * request) with a configuration. The IDE opens another connection to the
 * adapter and runs a second DebugSession with attach(config): the same
 * startup, with `attach` instead of `launch`.
 */
import { DapClient, type DapEvent } from './dapClient'
import type { Breakpoint } from './breakpoints'

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
  /** The thread that stopped, and all threads (Python threads of the program). */
  threadId: number
  threads: { id: number; name: string }[]
}

/** An exception setting the adapter offers ("Raised Exceptions", "Uncaught Exceptions"...). */
export interface ExceptionFilter {
  filter: string
  label: string
  default: boolean
}

/** Run the program in a terminal (debugpy's runInTerminal request): returns its process id. */
export type RunInTerminal = (args: { title?: string; cwd: string; args: string[]; env?: Record<string, string | null> }) => Promise<number | undefined>

export interface SessionHooks {
  send(message: unknown): void
  onState(state: DebugState): void
  onOutput(category: 'stdout' | 'stderr' | 'console', text: string): void
  onPaused(info: PauseInfo): void
  onEnded(exitCode: number | null): void
  /** The program started a child process to debug: attach to it with this configuration. */
  onChildProcess?(config: ChildConfig): void
}

/** debugpy's configuration for attaching to a child process. */
export interface ChildConfig {
  connect: { host: string; port: number }
  subProcessId?: number
  name?: string
  [key: string]: unknown
}

/** A valid child configuration, or null. */
export function childConfig(raw: unknown): ChildConfig | null {
  const c = raw as ChildConfig | null
  if (!c || typeof c !== 'object' || !c.connect || typeof c.connect.host !== 'string' || typeof c.connect.port !== 'number') return null
  return c
}

/** Breakpoints and exception settings sent during startup (launch and attach). */
export interface SessionSetup {
  breakpoints: { path: string; breakpoints: readonly Breakpoint[] }[]
  /** Which exception settings to turn on (filter ids); undefined = "uncaught" if offered. */
  exceptionFilters?: string[]
}

export interface LaunchOptions extends SessionSetup {
  /** The script to debug, or null to debug `module` (python -m). */
  program: string | null
  module?: string | null
  args?: string[]
  env?: Record<string, string>
  cwd: string
  /** Run the program in a terminal (so input() works) instead of the Debug console. */
  runInTerminal?: RunInTerminal
}

export class DebugSession {
  readonly client: DapClient
  private _state: DebugState = 'idle'
  private threadId: number | null = null
  private exitCode: number | null = null
  private configured = false
  private initialized: Promise<void>
  /** Exception settings the adapter offers (known after startup). */
  exceptionFilters: ExceptionFilter[] = []

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
    // Newer debugpy asks for child processes with a request instead of the event.
    this.client.onRequest('startDebugging', (a: { configuration?: unknown }) => {
      const config = childConfig(a?.configuration)
      if (!config) throw new Error('No configuration to attach with')
      this.hooks.onChildProcess?.(config)
      return {}
    })
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
    const inTerminal = !!opts.runInTerminal
    if (opts.runInTerminal) {
      const run = opts.runInTerminal
      this.client.onRequest('runInTerminal', async (a: { title?: string; cwd: string; args: string[]; env?: Record<string, string | null> }) => {
        const processId = await run(a)
        return processId ? { processId } : {}
      })
    }
    await this.initialize(inTerminal)
    const launch = this.client.request('launch', {
      name: 'Forge', type: 'python', request: 'launch',
      ...(opts.module ? { module: opts.module } : { program: opts.program }),
      args: opts.args ?? [], cwd: opts.cwd,
      // In a terminal the program gets a real keyboard (input() works); its output shows there.
      console: inTerminal ? 'integratedTerminal' : 'internalConsole', redirectOutput: !inTerminal,
      justMyCode: true, showReturnValue: true,
      // Follow child processes (multiprocessing, subprocess running python): see onChildProcess.
      subProcess: true,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env }
    })
    await this.configure(launch, opts)
  }

  /** Debug a child process of the program (a configuration from onChildProcess), on its own connection. */
  async attach(config: ChildConfig, setup: SessionSetup): Promise<void> {
    this.setState('starting')
    await this.initialize(false)
    await this.configure(this.client.request('attach', config), setup)
  }

  private async initialize(inTerminal: boolean): Promise<void> {
    const caps = await this.client.request('initialize', {
      clientID: 'ideforfun', clientName: 'Forge', adapterID: 'debugpy', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
      supportsVariableType: true, supportsRunInTerminalRequest: inTerminal
    })
    this.exceptionFilters = (caps?.exceptionBreakpointFilters ?? []).map((f: any) => ({ filter: String(f.filter), label: String(f.label ?? f.filter), default: !!f.default }))
  }

  /** After launch/attach was sent: breakpoints, exception settings, configurationDone, then its answer. */
  private async configure(request: Promise<unknown>, setup: SessionSetup): Promise<void> {
    request.catch(() => {}) // awaited below; avoid an "unhandled" warning if it fails early
    await Promise.race([this.initialized, request])

    for (const f of setup.breakpoints) await this.sendBreakpoints(f.path, f.breakpoints)
    // By default pause where an exception would crash the program, so you can look around.
    const offered = new Set(this.exceptionFilters.map((f) => f.filter))
    const filters = (setup.exceptionFilters ?? ['uncaught']).filter((f) => offered.has(f))
    await this.client.request('setExceptionBreakpoints', { filters })
    await this.client.request('configurationDone')
    this.configured = true
    await request
    if (this._state === 'starting') this.setState('running')
  }

  /** Update one file's breakpoints while running (no-op before startup is done). */
  async setBreakpoints(path: string, bps: readonly Breakpoint[]): Promise<void> {
    if (!this.configured || !this.active) return
    await this.sendBreakpoints(path, bps)
  }

  /** Change which exceptions pause the program, while it runs. */
  async setExceptionFilters(filters: string[]): Promise<void> {
    if (!this.configured || !this.active) return
    const offered = new Set(this.exceptionFilters.map((f) => f.filter))
    await this.client.request('setExceptionBreakpoints', { filters: filters.filter((f) => offered.has(f)) })
  }

  private async sendBreakpoints(path: string, bps: readonly Breakpoint[]): Promise<void> {
    await this.client.request('setBreakpoints', {
      source: { path },
      // Switched-off breakpoints aren't sent at all.
      breakpoints: bps.filter((b) => b.enabled).map((b) => ({
        line: b.line + 1,
        ...(b.condition ? { condition: b.condition } : {}),
        ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
        ...(b.logMessage ? { logMessage: b.logMessage } : {})
      })),
      sourceModified: false
    })
  }

  /** The program's threads. */
  async threads(): Promise<{ id: number; name: string }[]> {
    const res = await this.client.request('threads')
    return (res.threads ?? []).map((t: any) => ({ id: t.id, name: String(t.name ?? `Thread ${t.id}`) }))
  }

  /** A thread's call stack (while paused). Stepping then applies to this thread. */
  async stackTrace(threadId: number): Promise<StackFrame[]> {
    const res = await this.client.request('stackTrace', { threadId, startFrame: 0, levels: 100 })
    this.threadId = threadId
    return (res.stackFrames ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? null,
      line: Math.max(0, (f.line ?? 1) - 1),
      col: Math.max(0, (f.column ?? 1) - 1)
    }))
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
  async evaluate(expression: string, frameId?: number, context: 'repl' | 'hover' | 'watch' = 'repl'): Promise<{ result: string; ref: number }> {
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
      case 'debugpyAttach': {
        const config = childConfig(e.body)
        if (config) this.hooks.onChildProcess?.(config)
        break
      }
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
    let threads: { id: number; name: string }[] = []
    const threadId = this.threadId
    let description: string | undefined = body.text ?? body.description
    try {
      frames = await this.stackTrace(threadId)
      threads = await this.threads().catch(() => [])
      if (body.reason === 'exception') {
        const info = await this.client.request('exceptionInfo', { threadId: this.threadId })
        description = [info.exceptionId, info.description].filter(Boolean).join(': ') || description
      }
    } catch {
      // the program may have ended meanwhile
    }
    if (this._state !== 'paused') return
    this.hooks.onPaused({ reason: body.reason ?? 'pause', description, frames, threadId, threads })
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
