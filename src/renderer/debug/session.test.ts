import { describe, expect, it } from 'vitest'
import { DebugSession, type PauseInfo } from './session'

/** A fake debugpy: answers requests from a table and records the order. */
function setup(answers: Record<string, (args: any) => any> = {}) {
  const commands: string[] = []
  const states: string[] = []
  const output: string[] = []
  const paused: PauseInfo[] = []
  const ended: (number | null)[] = []
  let session!: DebugSession
  let launchSeq = 0
  const reply = (msg: any, body: any) =>
    queueMicrotask(() => session.handleMessage({ type: 'response', request_seq: msg.seq, command: msg.command, success: true, body }))
  const event = (name: string, body?: any) => queueMicrotask(() => session.handleMessage({ type: 'event', event: name, body }))
  session = new DebugSession({
    send: (msg: any) => {
      if (msg.type !== 'request') return
      commands.push(msg.command)
      if (msg.command === 'launch') {
        launchSeq = msg.seq
        event('initialized') // debugpy answers launch only after configurationDone
        return
      }
      if (msg.command === 'configurationDone') {
        reply(msg, {})
        queueMicrotask(() => session.handleMessage({ type: 'response', request_seq: launchSeq, command: 'launch', success: true }))
        return
      }
      const fn = answers[msg.command]
      reply(msg, fn ? fn(msg.arguments) : msg.command === 'initialize' ? { exceptionBreakpointFilters: [{ filter: 'raised' }, { filter: 'uncaught' }] } : {})
    },
    onState: (s) => states.push(s),
    onOutput: (c, t) => output.push(`${c}:${t}`),
    onPaused: (p) => paused.push(p),
    onEnded: (code) => ended.push(code)
  })
  return { session, commands, states, output, paused, ended, event }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('DebugSession', () => {
  it('does the startup handshake in the order debugpy expects', async () => {
    const bpArgs: any[] = []
    const t = setup({ setBreakpoints: (a) => { bpArgs.push(a); return { breakpoints: [] } } })
    await t.session.start({ program: '/p/main.py', cwd: '/p', breakpoints: [{ path: '/p/main.py', lines: [0, 4] }, { path: '/p/lib.py', lines: [2] }] })
    expect(t.commands).toEqual(['initialize', 'launch', 'setBreakpoints', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone'])
    expect(bpArgs[0]).toEqual({ source: { path: '/p/main.py' }, breakpoints: [{ line: 1 }, { line: 5 }], sourceModified: false })
    expect(t.states).toEqual(['starting', 'running'])
  })

  it('on a breakpoint: pauses, reports frames with 0-based lines, then steps', async () => {
    const t = setup({
      stackTrace: () => ({ stackFrames: [{ id: 7, name: 'greet', line: 3, column: 5, source: { path: '/p/main.py' } }, { id: 8, name: '<module>', line: 10, column: 1 }] })
    })
    await t.session.start({ program: '/p/main.py', cwd: '/p', breakpoints: [] })
    t.event('stopped', { reason: 'breakpoint', threadId: 1 })
    await flush(); await flush(); await flush()
    expect(t.states.at(-1)).toBe('paused')
    expect(t.paused[0]).toEqual({
      reason: 'breakpoint', description: undefined,
      frames: [{ id: 7, name: 'greet', path: '/p/main.py', line: 2, col: 4 }, { id: 8, name: '<module>', path: null, line: 9, col: 0 }]
    })
    await t.session.stepOver()
    expect(t.commands.at(-1)).toBe('next')
    expect(t.states.at(-1)).toBe('running')
  })

  it('describes the exception when stopped on one', async () => {
    const t = setup({
      stackTrace: () => ({ stackFrames: [{ id: 1, name: 'f', line: 1, column: 1, source: { path: '/p/a.py' } }] }),
      exceptionInfo: () => ({ exceptionId: 'ZeroDivisionError', description: 'division by zero' })
    })
    await t.session.start({ program: '/p/a.py', cwd: '/p', breakpoints: [] })
    t.event('stopped', { reason: 'exception', threadId: 1 })
    await flush(); await flush(); await flush(); await flush()
    expect(t.paused[0].description).toBe('ZeroDivisionError: division by zero')
  })

  it('passes program output on and ends with the exit code', async () => {
    const t = setup()
    await t.session.start({ program: '/p/a.py', cwd: '/p', breakpoints: [] })
    t.event('output', { category: 'stdout', output: 'hi\n' })
    t.event('output', { category: 'telemetry', output: 'x' })
    t.event('exited', { exitCode: 3 })
    t.event('terminated')
    await flush()
    expect(t.output).toEqual(['stdout:hi\n'])
    expect(t.ended).toEqual([3])
    expect(t.session.state).toBe('idle')
  })

  it('stepping does nothing unless paused', async () => {
    const t = setup()
    await t.session.start({ program: '/p/a.py', cwd: '/p', breakpoints: [] })
    const before = t.commands.length
    await t.session.continue()
    expect(t.commands.length).toBe(before)
  })
})
