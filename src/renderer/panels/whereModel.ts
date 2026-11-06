/**
 * Data for the Where you are and In this file panels, from the project
 * graph (src/shared/projectGraph.ts): the current module's neighbours, and a
 * one-line summary of what each function reaches and who uses it.
 */
import type { ProjectGraph } from '../../shared/projectGraph'

/** The module of a project-relative file path (either slash), or null if it isn't one. */
export function moduleForPath(g: ProjectGraph, relPath: string): string | null {
  const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  return g.modules.find((m) => m.path === path)?.id ?? null
}

export interface Neighbourhood {
  module: string
  /** Project modules it imports. */
  imports: string[]
  /** Project modules that import it. */
  importedBy: string[]
  /** Web API hosts its code calls. */
  hosts: string[]
}

export function neighbourhood(g: ProjectGraph, module: string): Neighbourhood {
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
  return {
    module,
    imports: sorted(g.imports.filter((e) => e.from === module).map((e) => e.to)),
    importedBy: sorted(g.imports.filter((e) => e.to === module).map((e) => e.from)),
    hosts: sorted(g.http.filter((h) => h.module === module && h.host).map((h) => h.host!))
  }
}

export interface SymbolSummary {
  qual: string
  kind: string
  line: number
  /** e.g. "→ github · used by main, routes" ('' when it neither reaches out nor is used elsewhere). */
  summary: string
}

const moduleOfId = (id: string) => (id.startsWith('module:') ? id.slice(7) : id.slice(0, id.indexOf(':')))

export function fileSummary(g: ProjectGraph, module: string): SymbolSummary[] {
  const m = g.modules.find((x) => x.id === module)
  if (!m) return []
  return [...m.symbols]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.line - b.s.line || a.i - b.i)
    .map(({ s }) => {
      const out = new Set<string>()
      for (const c of g.calls) if (c.from === s.id && moduleOfId(c.to) !== module) out.add(moduleOfId(c.to))
      const hosts = new Set(g.http.filter((h) => h.module === module && h.func === s.qual && h.host).map((h) => h.host!))
      const usedBy = new Set<string>()
      for (const c of g.calls) if (c.to === s.id && moduleOfId(c.from) !== module) usedBy.add(moduleOfId(c.from))
      const reaches = [...[...hosts].sort(), ...[...out].sort()]
      const parts = [reaches.length ? `→ ${reaches.join(', ')}` : '', usedBy.size ? `used by ${[...usedBy].sort().join(', ')}` : ''].filter(Boolean)
      return { qual: s.qual, kind: s.kind, line: s.line, summary: parts.join(' · ') }
    })
}
