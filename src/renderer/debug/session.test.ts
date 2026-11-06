import { describe, expect, it } from 'vitest'
import { DebugSession, type ChildConfig, type PauseInfo } from './session'

/** A fake debugpy: answers requests from a table and records the order. */
function setup(answers: Record<string, (args: any) => any> = {}) {
  const commands: string[] = []
  const states: string[] = []
  const output: string[] = []
  const paused: PauseInfo[] = []
  const ended: (number | null)[] = []
  const children: ChildConfig[] = []
  const sent: any[] = []
  let session!: DebugSession
  let launchSeq = 0
  const reply = (msg: any, body: any) =>
    queueMicrotask(() => session.handleMessage({ type: 'response', request_seq: msg.seq, command: msg.command, success: true, body }))
  const event = (name: string, body?: any) => queueMicrotask(() => session.handleMessage({ type: 'event', event: name, body }))
  session = new DebugSession({
    send: (msg: any) => {
      sent.push(msg)
      if (msg.type !== 'request') return
      commands.push(msg.command)
      if (msg.command === 'launch' || msg.command === 'attach') {
        launchSeq = msg.seq
        event('initialized') // debugpy answers launch only after configurationDone
        return
      }
      if (msg.command === 'configurationDone') {
        reply(msg, {})
        queueMicrotask(() => session.handleMessage({ type: 'response', request_seq: launchSeq, command: commands.includes('attach') ? 'attach' : 'launch', success: true }))
        return
      }
      const fn = answers[msg.command]
      reply(msg, fn ? fn(msg.arguments) : msg.command === 'initialize' ? { exceptionBreakpointFilters: [{ filter: 'raised' }, { filter: 'uncaught' }] } : {})
    },
    onState: (s) => states.push(s),
    onOutput: (c, t) => output.push(`${c}:${t}`),
    onPaused: (p) => paused.push(p),
    onEnded: (code) => ended.push(code),
    onChildProcess: (c) => children.push(c)
  })
  return { session, commands, states, output, paused, ended, event, children, sent }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('DebugSession', () => {
  it('does the startup handshake in the order debugpy expects', async () => {
    const bpArgs: any[] = []
    const t = setup({ setBreakpoints: (a) => { bpArgs.push(a); return { breakpoints: [] } } })
    await t.session.start({ program: '/p/main.py', cwd: '/p', breakpoints: [
      { path: '/p/main.py', breakpoints: [{ line: 0, enabled: true }, { line: 4, enabled: true, condition: 'x > 1' }, { line: 6, enabled: false }] },
      { path: '/p/lib.py', breakpoints: [{ line: 2, enabled: true, logMessage: 'hi {x}', hitCondition: '3' }] }
    ] })
    expect(t.commands).toEqual(['initialize', 'launch', 'setBreakpoints', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone'])
    // Switched-off breakpoints aren't sent; conditions and log messages are.
    expect(bpArgs[0]).toEqual({ source: { path: '/p/main.py' }, breakpoints: [{ line: 1 }, { line: 5, condition: 'x > 1' }], sourceModified: false })
    expect(bpArgs[1].breakpoints).toEqual([{ line: 3, logMessage: 'hi {x}', hitCondition: '3' }])
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
      frames: [{ id: 7, name: 'greet', path: '/p/main.py', line: 2, col: 4 }, { id: 8, name: '<module>', path: null, line: 9, col: 0 }],
      threadId: 1, threads: []
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

  it('follows child processes: launch asks for subProcess, and debugpyAttach is reported', async () => {
    const t = setup()
    let launchArgs: any
    const orig = t.sent
    await t.session.start({ program: '/p/main.py', cwd: '/p', breakpoints: [] })
    launchArgs = orig.find((m) => m.command === 'launch').arguments
    expect(launchArgs.subProcess).toBe(true)
    t.event('debugpyAttach', { name: 'Subprocess 4242', request: 'attach', subProcessId: 4242, connect: { host: '127.0.0.1', port: 5678 } })
    t.event('debugpyAttach', { name: 'broken' }) // no address: ignored
    await flush()
    expect(t.children).toEqual([{ name: 'Subprocess 4242', request: 'attach', subProcessId: 4242, connect: { host: '127.0.0.1', port: 5678 } }])
  })

  it('also answers the newer startDebugging request', async () => {
    const t = setup()
    await t.session.start({ program: '/p/main.py', cwd: '/p', breakpoints: [] })
    t.session.handleMessage({ type: 'request', seq: 900, command: 'startDebugging', arguments: { request: 'attach', configuration: { subProcessId: 7, connect: { host: '127.0.0.1', port: 1234 } } } })
    t.session.handleMessage({ type: 'request', seq: 901, command: 'startDebugging', arguments: { request: 'attach', configuration: {} } })
    await flush()
    expect(t.children.map((c) => c.subProcessId)).toEqual([7])
    const answers = t.sent.filter((m) => m.type === 'response')
    expect(answers.map((a) => [a.request_seq, a.success])).toEqual([[900, true], [901, false]])
  })

  it('attaches to a child with the same startup (breakpoints, exceptions) as a launch', async () => {
    const bpArgs: any[] = []
    const t = setup({ setBreakpoints: (a) => { bpArgs.push(a); return { breakpoints: [] } } })
    const config = { subProcessId: 7, connect: { host: '127.0.0.1', port: 1234 }, justMyCode: true }
    await t.session.attach(config, { breakpoints: [{ path: '/p/worker.py', breakpoints: [{ line: 1, enabled: true }] }], exceptionFilters: ['raised'] })
    expect(t.commands).toEqual(['initialize', 'attach', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone'])
    expect(t.sent.find((m) => m.command === 'attach').arguments).toEqual(config)
    expect(t.sent.find((m) => m.command === 'setExceptionBreakpoints').arguments).toEqual({ filters: ['raised'] })
    expect(bpArgs[0].source).toEqual({ path: '/p/worker.py' })
    expect(t.states).toEqual(['starting', 'running'])
  })
})
