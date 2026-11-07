/**
 * Traced runs: the program is started through Forge's tracer (runTrace.py),
 * which reports "where it's at" over a local socket opened here for the run.
 */
import { createServer, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import TRACER from './runTrace.py?raw'

/**
 * The tracer goes on the command line (no file to write or clean up), packed:
 * Windows limits a command line to 32,767 characters and the script alone is
 * about that size.
 */
const BOOT = `import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('${deflateSync(Buffer.from(TRACER, 'utf8'), { level: 9 }).toString('base64')}')),'<forge-trace>','exec'))`

/** Python's arguments for a traced run (`target` is `[file]` or `['-m', module]`). */
export function traceCommand(target: string[], args: string[]): string[] {
  const t = target[0] === '-m' ? ['--module', target[1]] : ['--script', target[0]]
  return ['-u', '-c', BOOT, ...t, ...args]
}

/** What the tracer reads from its environment (it removes them before the program runs). */
export function traceEnv(root: string, port: number, token: string): Record<string, string> {
  return { FORGE_TRACE_ROOT: root, FORGE_TRACE_PORT: String(port), FORGE_TRACE_TOKEN: token }
}

/**
 * A socket for one run: accepts one tracer (which must say the token first)
 * and passes on each message it sends.
 */
export function openTraceServer(onMessage: (message: unknown) => void): Promise<{ port: number; token: string; close(): void }> {
  const token = randomBytes(16).toString('hex')
  let taken = false
  const sockets = new Set<Socket>()
  const server = createServer((sock) => {
    if (taken) {
      sock.destroy()
      return
    }
    taken = true
    sockets.add(sock)
    sock.setEncoding('utf8')
    let buffer = ''
    let trusted = false
    sock.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4_000_000) {
        sock.destroy()
        return
      }
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (!trusted) {
          const hello = msg as { t?: unknown; token?: unknown }
          if (hello?.t !== 'hello' || hello.token !== token) {
            sock.destroy()
            return
          }
          trusted = true
        }
        onMessage(msg)
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(sock))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        token,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        }
      })
    })
  })
}
