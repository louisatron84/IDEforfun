/**
 * A small Debug Adapter Protocol client. DAP is like LSP but with its own
 * message shapes: requests carry a `seq` and `command`, responses point back
 * with `request_seq`, and the adapter also sends events (stopped, output...).
 */

export interface DapEvent {
  type: 'event'
  event: string
  body?: any
}

interface DapResponse {
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: any
}

interface DapRequest {
  type: 'request'
  seq: number
  command: string
  arguments?: any
}

export class DapClient {
  private seq = 0
  private readonly pending = new Map<number, { resolve: (body: any) => void; reject: (err: Error) => void }>()
  private readonly eventListeners = new Set<(e: DapEvent) => void>()
  /** Answers to requests the adapter sends us (e.g. runInTerminal). */
  private readonly requestHandlers = new Map<string, (args: any) => Promise<unknown> | unknown>()

  onRequest(command: string, handler: (args: any) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(command, handler)
  }

  constructor(private readonly send: (message: unknown) => void) {}

  /** Send a request; resolves with the response body, rejects if the adapter says it failed. */
  request<T = any>(command: string, args?: unknown): Promise<T> {
    const seq = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject })
      this.send({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) })
    })
  }

  onEvent(listener: (e: DapEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Feed every message that arrives from the adapter. */
  handleMessage(raw: unknown): void {
    const msg = raw as DapResponse | DapEvent | DapRequest
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq)
      if (!p) return
      this.pending.delete(msg.request_seq)
      if (msg.success) p.resolve(msg.body ?? {})
      else p.reject(new Error(msg.body?.error?.format ?? msg.message ?? `${msg.command} failed`))
    } else if (msg.type === 'event') {
      for (const l of this.eventListeners) l(msg)
    } else if (msg.type === 'request') {
      // Reverse requests (e.g. runInTerminal): answer the ones we handle, refuse the rest.
      const handler = this.requestHandlers.get(msg.command)
      const reply = (success: boolean, body?: unknown, message?: string) => this.send({
        seq: ++this.seq, type: 'response', request_seq: msg.seq, command: msg.command, success,
        ...(body === undefined ? {} : { body }), ...(message ? { message } : {})
      })
      if (!handler) return reply(false, undefined, `${msg.command} is not supported`)
      void Promise.resolve()
        .then(() => handler(msg.arguments ?? {}))
        .then((body) => reply(true, body ?? {}), (err) => reply(false, undefined, err instanceof Error ? err.message : String(err)))
    }
  }

  /** The adapter is gone: fail everything still waiting for an answer. */
  dispose(reason = 'The debugger stopped'): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
}
