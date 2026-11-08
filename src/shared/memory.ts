/**
 * The Memory explorer's data: what the run tracer reports when memory
 * tracking is on (`{"t":"mem"}`, see runTrace.py), collected for one run.
 */

export interface MemSite {
  /** Project file (relative, / separators) and 1-based line. */
  path: string
  line: number
  bytes: number
  count: number
}

export interface MemKept {
  /** `module.Class` */
  type: string
  count: number
  /** From a module's variable to the object's container: ["app.CACHE", "list"]; empty if not found. */
  path: string[]
}

export interface MemMessage {
  /** [seconds since the start, bytes in use] */
  samples: [number, number][]
  peak: number
  sites?: MemSite[]
  types?: [string, number][]
  final: boolean
  kept?: MemKept[]
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const str = (v: unknown): v is string => typeof v === 'string'

export function parseMem(raw: unknown): MemMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.t !== 'mem' || !Array.isArray(m.samples) || !num(m.peak)) return null
  const out: MemMessage = {
    samples: m.samples.filter((s): s is [number, number] => Array.isArray(s) && num(s[0]) && num(s[1])).map((s) => [s[0], s[1]]),
    peak: m.peak,
    final: m.final === true
  }
  if (Array.isArray(m.sites)) {
    out.sites = m.sites
      .filter((s): s is [string, number, number, number] => Array.isArray(s) && str(s[0]) && Number.isInteger(s[1]) && num(s[2]) && num(s[3]))
      .map((s) => ({ path: s[0], line: s[1], bytes: s[2], count: s[3] }))
  }
  if (Array.isArray(m.types)) out.types = m.types.filter((t): t is [string, number] => Array.isArray(t) && str(t[0]) && num(t[1])).map((t) => [t[0], t[1]])
  if (Array.isArray(m.kept)) {
    out.kept = m.kept
      .filter((k): k is MemKept => !!k && typeof k === 'object' && str((k as MemKept).type) && num((k as MemKept).count) && Array.isArray((k as MemKept).path) && (k as MemKept).path.every(str))
      .map((k) => ({ type: k.type, count: k.count, path: [...k.path] }))
  }
  return out
}

/** One run's memory, as it comes in. */
export class MemoryLog {
  runId = -1
  samples: [number, number][] = []
  peak = 0
  sites: MemSite[] = []
  /** Per class: [seconds, live objects] at each count. */
  types = new Map<string, [number, number][]>()
  kept: MemKept[] = []
  running = false

  begin(runId: number): void {
    this.runId = runId
    this.samples = []
    this.peak = 0
    this.sites = []
    this.types = new Map()
    this.kept = []
    this.running = true
  }

  add(m: MemMessage): void {
    this.samples.push(...m.samples)
    this.peak = Math.max(this.peak, m.peak)
    if (m.sites) this.sites = m.sites
    if (m.types) {
      const at = m.samples.length ? m.samples[0][0] : (this.samples.at(-1)?.[0] ?? 0)
      for (const [name, count] of m.types) {
        const list = this.types.get(name) ?? []
        list.push([at, count])
        this.types.set(name, list)
      }
    }
    if (m.kept) this.kept = m.kept
    if (m.final) this.running = false
  }

  /** The latest count of a class's live objects. */
  count(type: string): number {
    return this.types.get(type)?.at(-1)?.[1] ?? 0
  }

  /**
   * Its live objects kept going up over the run (never dropping by much) and
   * at least doubled: what a leak looks like.
   */
  growing(type: string): boolean {
    const list = this.types.get(type)
    if (!list || list.length < 3) return false
    const first = list[0][1]
    const last = list[list.length - 1][1]
    if (last < first * 2 || last - first < 20) return false
    for (let i = 1; i < list.length; i++) if (list[i][1] < list[i - 1][1] * 0.9) return false
    return true
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  const mb = n / (1024 * 1024)
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`
}
