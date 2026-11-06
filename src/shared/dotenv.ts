/**
 * The project's .env file as text: reading variables, changing one while
 * keeping every other line exactly as it was, and merging with the real
 * environment (which always wins, as in VS Code's Python extension).
 */

const LINE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.startsWith('"')) {
    let out = ''
    for (let i = 1; i < v.length; i++) {
      const ch = v[i]
      if (ch === '\\' && i + 1 < v.length) {
        const next = v[++i]
        out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next
      } else if (ch === '"') return out
      else out += ch
    }
    return out
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1)
    return end < 0 ? v.slice(1) : v.slice(1, end)
  }
  const hash = v.search(/\s#/)
  return (hash < 0 ? v : v.slice(0, hash)).trim()
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const m = LINE.exec(line)
    if (m) out[m[2]] = unquote(m[3])
  }
  return out
}

function quote(value: string): string {
  if (value !== '' && !/[\s#"'\\]/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

/** Set one variable: replaces its first line (keeping `export`), else appends it. */
export function setDotEnvVar(text: string, name: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i])
    if (m && m[2] === name && !/^\s*#/.test(lines[i])) {
      lines[i] = `${m[1] ?? ''}${name}=${quote(value)}`
      return lines.join(eol)
    }
  }
  const body = text === '' || text.endsWith('\n') ? text : text + eol
  return `${body}${name}=${quote(value)}${eol}`
}

/** The environment for a process: `.env` only fills names the real environment doesn't have. */
export function mergeEnv(base: Record<string, string | undefined>, dotenv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(dotenv)) out[k] = v
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v
  return out
}
