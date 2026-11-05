/**
 * File path <-> file:// URI, as used by the Language Server Protocol.
 * Written by hand (instead of node:url) so the renderer can use it too.
 */

export function pathToUri(path: string): string {
  const win = /^[a-zA-Z]:[\\/]/.test(path)
  let p = path.replace(/\\/g, '/')
  if (win) p = '/' + p[0].toLowerCase() + ':' + p.slice(2)
  const encoded = p.split('/').map((seg) => encodeURIComponent(seg)).join('/')
  return 'file://' + encoded
}

export function uriToPath(uri: string): string {
  const p = decodeURIComponent(uri.replace(/^file:\/\//, ''))
  const win = /^\/[a-zA-Z]:/.exec(p)
  if (win) return p[1].toUpperCase() + ':' + p.slice(3).replace(/\//g, '\\')
  return p
}
