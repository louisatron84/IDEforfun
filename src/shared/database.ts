/**
 * The Database explorer's schema: the project's tables, from three places
 * the analysis finds them (see projectScan.py):
 *
 * - ORM models (SQLAlchemy, SQLModel, Django, Peewee);
 * - CREATE TABLE statements in SQL strings;
 * - a SQLite file the code opens, read as it really is.
 *
 * The same table found in several places is one table (its code wins for the
 * columns; `sources` says where it was seen). Relations come from foreign
 * keys, many-to-many fields, and relationship() where no key already links
 * the two tables.
 */
import type { RawDbColumn, RawScan } from './projectGraph'

export type DbSource = 'model' | 'sql' | 'database'

export interface DbColumn {
  name: string
  type: string
  pk?: boolean
  unique?: boolean
  /** The table it refers to (resolved to a table's name when the project has it). */
  fk?: string
  implicit?: boolean
}

export interface DbTable {
  /** The table's name in lower case (tables are matched without case). */
  id: string
  name: string
  /** The model class, for a table defined by one. */
  model?: string
  framework?: string
  /** Where it's defined in the code (none for a table only in the database file). */
  module?: string
  path?: string
  line?: number
  columns: DbColumn[]
  sources: DbSource[]
  /** Functions that use the model (`module:qual`). */
  usedBy: string[]
}

export interface DbRelation {
  from: string
  to: string
  kind: 'fk' | 'many' | 'relationship'
  column?: string
}

export interface DbConnection {
  kind: string
  library: string
  target: string | null
  module: string
  path: string
  func: string | null
  line: number
  /** The project's SQLite file whose tables were read. */
  file?: string
  error?: string
}

export interface DbSchema {
  tables: DbTable[]
  relations: DbRelation[]
  connections: DbConnection[]
}

const ORDER: DbSource[] = ['model', 'sql', 'database']

export function buildSchema(scan: RawScan): DbSchema {
  const tables = new Map<string, DbTable & { modelFks: Map<string, string>; colsFrom: DbSource | null }>()
  const connections: DbConnection[] = []
  /** Model class → table id (for Django / Peewee keys, which name the class). */
  const byClass = new Map<string, string>()
  const manyRels: { from: string; toClass: string }[] = []
  const softRels: { from: string; toClass: string }[] = []

  const add = (name: string, source: DbSource, cols: RawDbColumn[], where?: { module: string; path: string; line: number; model?: string; framework?: string }) => {
    const id = name.toLowerCase()
    let t = tables.get(id)
    if (!t) {
      t = { id, name, columns: [], sources: [], usedBy: [], modelFks: new Map(), colsFrom: null }
      tables.set(id, t)
    }
    if (!t.sources.includes(source)) t.sources.push(source)
    t.sources.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    // Columns from the most telling source: the model, then the SQL, then the file.
    if (cols.length && (t.colsFrom === null || ORDER.indexOf(source) < ORDER.indexOf(t.colsFrom))) {
      t.colsFrom = source
      t.modelFks.clear()
      t.columns = cols.map((c) => {
        const col: DbColumn = { name: c.name, type: c.type }
        if (c.pk) col.pk = true
        if (c.unique) col.unique = true
        if (c.fk) col.fk = c.fk
        if (c.implicit) col.implicit = true
        if (c.fkModel) t!.modelFks.set(c.name, c.fkModel)
        return col
      })
    }
    if (where && t.module === undefined) {
      t.module = where.module
      t.path = where.path
      t.line = where.line
      if (where.model) t.model = where.model
      if (where.framework) t.framework = where.framework
    }
    return t
  }

  for (const f of scan.files) {
    const db = f.db
    if (!db) continue
    for (const m of db.models) {
      const t = add(m.table, 'model', m.columns, { module: f.module, path: f.path, line: m.line, model: m.name, framework: m.framework })
      byClass.set(m.name, t.id)
      for (const r of m.rels) (r.kind === 'many' ? manyRels : softRels).push({ from: t.id, toClass: r.to })
    }
    for (const s of db.tables) add(s.name, 'sql', s.columns, { module: f.module, path: f.path, line: s.line })
    for (const c of db.connections) {
      const conn: DbConnection = { kind: c.kind, library: c.library, target: c.target, module: f.module, path: f.path, func: c.func, line: c.line }
      if (c.schema) {
        conn.file = c.schema.file
        if (c.schema.error) conn.error = c.schema.error
        for (const t of c.schema.tables ?? []) add(t.name, 'database', t.columns)
      }
      connections.push(conn)
    }
  }

  // Foreign keys to a table the project has: by its name (any case), or by the model class it names.
  const relations: DbRelation[] = []
  const linked = new Set<string>()
  for (const t of tables.values()) {
    for (const c of t.columns) {
      const fromModel = t.modelFks.get(c.name)
      const target = fromModel ? byClass.get(fromModel) : c.fk?.toLowerCase()
      if (!target || !tables.has(target)) continue
      c.fk = tables.get(target)!.name
      relations.push({ from: t.id, to: target, kind: 'fk', column: c.name })
      linked.add(`${t.id}|${target}`).add(`${target}|${t.id}`)
    }
  }
  for (const r of manyRels) {
    const to = byClass.get(r.toClass)
    if (to) relations.push({ from: r.from, to, kind: 'many' })
  }
  for (const r of softRels) {
    const to = byClass.get(r.toClass)
    if (!to || to === r.from || linked.has(`${r.from}|${to}`)) continue
    relations.push({ from: r.from, to, kind: 'relationship' })
    linked.add(`${r.from}|${to}`).add(`${to}|${r.from}`)
  }

  // Where each model is used: functions that name its class.
  const models = new Map<string, DbTable>()
  for (const t of tables.values()) if (t.model) models.set(t.model, t)
  if (models.size) {
    for (const f of scan.files) {
      for (const d of f.defs) {
        if (d.kind !== 'function' && d.kind !== 'method') continue
        for (const r of d.refs) {
          const t = models.get(r)
          if (t && !t.usedBy.includes(`${f.module}:${d.qual}`)) t.usedBy.push(`${f.module}:${d.qual}`)
        }
      }
    }
  }

  const out = [...tables.values()].map(({ modelFks: _m, colsFrom: _c, ...t }) => t)
  return { tables: out.sort((a, b) => a.name.localeCompare(b.name)), relations, connections }
}
