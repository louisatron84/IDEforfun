/**
 * A minimal JSON-RPC client for the Language Server Protocol.
 * It doesn't know how messages travel (the main process pipes them to the
 * server); it just matches responses to requests and dispatches the rest.
 */

type Id = number | string

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class LspClient {
  private nextId = 1
  private readonly pending = new Map<Id, Pending>()
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>()

  constructor(private readonly send: (message: unknown) => void) {}

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  onNotification(method: string, handler: (params: any) => void): void {
    let set = this.notificationHandlers.get(method)
    if (!set) this.notificationHandlers.set(method, (set = new Set()))
    set.add(handler)
  }

  /** Handle a request *from* the server (e.g. workspace/configuration). */
  onRequest(method: string, handler: (params: any) => unknown): void {
    this.requestHandlers.set(method, handler)
  }

  handleMessage(raw: unknown): void {
    const msg = raw as { id?: Id; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
    if (msg.method === undefined && msg.id !== undefined) {
      // A response to one of our requests.
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    } else if (msg.method !== undefined && msg.id !== undefined) {
      // A request from the server: always answer, or it may wait forever.
      const id = msg.id
      const handler = this.requestHandlers.get(msg.method)
      void Promise.resolve(handler ? handler(msg.params) : null).then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
        (err: unknown) => this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } })
      )
    } else if (msg.method !== undefined) {
      this.notificationHandlers.get(msg.method)?.forEach((h) => h(msg.params))
    }
  }

  /** Reject everything still waiting (server stopped or restarted). */
  dispose(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
}
