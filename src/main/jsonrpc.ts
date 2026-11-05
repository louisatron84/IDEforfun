/**
 * JSON-RPC message framing used by the Language Server Protocol:
 * each message is "Content-Length: <bytes>\r\n\r\n<json>".
 */

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** Collects bytes from a stream and calls `onMessage` for each complete message. */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly onMessage: (message: unknown) => void) {}

  feed(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Malformed header: drop it and resync on the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return // wait for the rest of the body
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.onMessage(JSON.parse(body))
      } catch {
        // ignore unparseable messages
      }
    }
  }
}
