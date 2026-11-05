/**
 * The project's Python dependencies: what requirements.txt / pyproject.toml
 * ask for, compared with what's installed in the interpreter, so missing
 * packages can be pointed out and installed.
 */

export interface Requirement {
  /** As written (e.g. "Django"). */
  name: string
  /** The rest of the line: version constraints, extras, markers ("" if none). */
  spec: string
}

export interface InstalledPackage {
  name: string
  version: string
}

/** Package names compare case-insensitively with -, _ and . the same (PEP 503). */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-')
}

const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/

/** One requirement string ("requests[socks]>=2; python_version>'3.8'") → name + spec, or null. */
export function parseRequirement(text: string): Requirement | null {
  const t = text.trim()
  // URLs / paths: only usable if they name the package with #egg=
  const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(t)
  if (/^(\w+\+)?(https?|file|git|ssh):|^[.~/\\]|^[A-Za-z]:[\\/]/.test(t)) return egg ? { name: egg[1], spec: '' } : null
  const m = NAME.exec(t)
  if (!m) return null
  // "name @ url" is a direct reference: still that package.
  return { name: m[1], spec: t.slice(m[1].length).trim() }
}

/** requirements.txt → requirements (skips comments, options like -r / -e / --index-url, and URLs without #egg=). */
export function parseRequirementsTxt(text: string): Requirement[] {
  const out: Requirement[] = []
  // Lines ending in \ continue on the next one.
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('-')) {
      // -e git+...#egg=name is an editable install of a named package
      const editable = /^(-e|--editable)\s+(.+)$/.exec(line)
      const req = editable ? parseRequirement(editable[2]) : null
      if (req) out.push(req)
      continue
    }
    const req = parseRequirement(line)
    if (req && !out.some((r) => normalizeName(r.name) === normalizeName(req.name))) out.push(req)
  }
  return out
}

/**
 * The [project] dependencies list from pyproject.toml. Not a full TOML
 * parser: it reads the `dependencies = [ "...", ... ]` array of the
 * [project] table, which is what packaging tools write.
 */
export function parsePyprojectDependencies(text: string): Requirement[] {
  const out: Requirement[] = []
  let table = ''
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, '')
    const header = /^\[([^\]]+)\]\s*(#.*)?$/.exec(line)
    if (header) {
      table = header[1].trim()
      continue
    }
    if (table !== 'project' || !/^dependencies\s*=/.test(line)) continue
    // Collect the array, which may span several lines.
    let body = line.slice(line.indexOf('=') + 1)
    while (!/\]\s*(#.*)?$/.test(body.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')) && i + 1 < lines.length) body += '\n' + lines[++i]
    for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      const req = parseRequirement(m[1] ?? m[2] ?? '')
      if (req) out.push(req)
    }
  }
  return out
}

/** Requirements that aren't installed (by normalized name; versions aren't checked). */
export function missingPackages(required: Requirement[], installed: InstalledPackage[]): Requirement[] {
  const have = new Set(installed.map((p) => normalizeName(p.name)))
  return required.filter((r) => !have.has(normalizeName(r.name)))
}

/** Parse `pip list --format=json` output. */
export function parsePipList(json: string): InstalledPackage[] {
  try {
    const data: unknown = JSON.parse(json)
    if (!Array.isArray(data)) return []
    return data
      .filter((p): p is { name: string; version: string } => !!p && typeof p.name === 'string' && typeof p.version === 'string')
      .map((p) => ({ name: p.name, version: p.version }))
  } catch {
    return []
  }
}

/** A name the user typed for "Install package…": letters, digits, ._- and optional [extras] / version spec. */
export function isInstallableSpec(text: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?\s*([<>=!~]=?\s*[\w.*+!-]+\s*,?\s*)*$/.test(text.trim())
}
