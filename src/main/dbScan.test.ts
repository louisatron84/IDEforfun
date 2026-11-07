/**
 * The Database explorer's analysis with a real Python (skipped if there is
 * none): ORM models, CREATE TABLE in SQL strings, connections, and the real
 * tables of a SQLite file the code opens.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScan } from './projectScan'
import { buildSchema, type DbSchema } from '../shared/database'
import type { RawScan } from '../shared/projectGraph'

function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'import sqlite3'], { stdio: 'ignore', timeout: 20000 })
      return cmd
    } catch {
      // try the next
    }
  }
  return null
}
const python = findPython()

const FILES: Record<string, string> = {
  'models_sa.py': [
    'from sqlalchemy import ForeignKey, String, create_engine',
    'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship',
    '',
    'class Base(DeclarativeBase):',
    '    pass',
    '',
    'class User(Base):',
    '    __tablename__ = "users"',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    name: Mapped[str] = mapped_column(String(50))',
    '    posts: Mapped[list["Post"]] = relationship(back_populates="author")',
    '',
    'class Post(Base):',
    '    __tablename__ = "posts"',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))',
    '    author: Mapped["User"] = relationship(back_populates="posts")',
    '',
    'engine = create_engine("postgresql://app:hunter2@db.example.com/blog")',
    '',
    'def newest():',
    '    return Post.id'
  ].join('\n'),
  'shop/__init__.py': '',
  'shop/models.py': [
    'from django.db import models',
    '',
    'class Customer(models.Model):',
    '    email = models.EmailField(unique=True)',
    '',
    'class Order(models.Model):',
    '    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)',
    '    items = models.ManyToManyField("Product")',
    '',
    'class Product(models.Model):',
    '    title = models.CharField(max_length=100)'
  ].join('\n'),
  'legacy.py': [
    'import sqlite3',
    '',
    'def setup():',
    '    con = sqlite3.connect("notes.db")',
    '    con.executescript("""',
    '        CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, tag_id INTEGER REFERENCES tags(id));',
    '        CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT);',
    '    """)',
    '    return con'
  ].join('\n'),
  'plain.py': 'def add(a, b):\n    return a + b\n'
}

describe.skipIf(!python)('database explorer analysis (real Python)', () => {
  let dir: string
  let scan: RawScan
  let schema: DbSchema
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forge-db-'))
    for (const [rel, text] of Object.entries(FILES)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    // The database the code opens: its tables as they really are (one more than the code creates).
    execFileSync(python!, ['-c', [
      'import sqlite3, sys',
      'con = sqlite3.connect(sys.argv[1])',
      'con.executescript("CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT); CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, tag_id INTEGER REFERENCES tags(id)); CREATE TABLE archive (id INTEGER PRIMARY KEY, note_id INTEGER REFERENCES notes(id));")',
      'con.commit(); con.close()'
    ].join('\n'), join(dir, 'notes.db')])
    const res = await runScan(python!, dir)
    expect(res.error).toBeUndefined()
    scan = res.scan!
    schema = buildSchema(scan)
  }, 60000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const table = (name: string) => schema.tables.find((t) => t.name === name)!
  const col = (t: string, c: string) => table(t).columns.find((x) => x.name === c)!

  it('finds the tables from models, SQL and the database file (and nothing in plain code)', () => {
    expect(schema.tables.map((t) => t.name).sort()).toEqual(['archive', 'customer', 'notes', 'order', 'posts', 'product', 'tags', 'users'])
    expect(scan.files.find((f) => f.path === 'plain.py')!.db).toBeUndefined()
  })

  it('SQLAlchemy models: table names, columns, keys, where they are', () => {
    const users = table('users')
    expect(users).toMatchObject({ model: 'User', framework: 'sqlalchemy', module: 'models_sa', path: 'models_sa.py', line: 7, sources: ['model'] })
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(col('users', 'id').pk).toBe(true)
    expect(col('users', 'name').type).toBe('String(50)')
    expect(col('users', 'id').type).toBe('int')
    expect(col('posts', 'author_id').fk).toBe('users')
  })

  it('Django models: the implicit id, foreign keys as <name>_id, many-to-many', () => {
    expect(table('order').columns.map((c) => c.name)).toEqual(['id', 'customer_id'])
    expect(col('order', 'id')).toMatchObject({ pk: true })
    expect(col('order', 'customer_id').fk).toBe('customer')
    expect(col('customer', 'email')).toMatchObject({ type: 'Email', unique: true })
  })

  it('relationships: foreign keys, many-to-many, and relationship() only where no key already links them', () => {
    const rels = schema.relations.map((r) => `${r.from} ${r.kind} ${r.to}`).sort()
    expect(rels).toEqual([
      'archive fk notes',
      'notes fk tags',
      'order fk customer',
      'order many product',
      'posts fk users'
    ])
  })

  it('CREATE TABLE in the code and the real database file are one table', () => {
    expect(table('notes').sources).toEqual(['sql', 'database'])
    expect(table('notes')).toMatchObject({ module: 'legacy', line: 5 })
    expect(col('notes', 'id').pk).toBe(true)
    expect(col('notes', 'tag_id').fk).toBe('tags')
    expect(table('archive').sources).toEqual(['database'])
  })

  it('connections: what kind, where, with passwords masked before they leave Python', () => {
    const conns = schema.connections.map((c) => ({ kind: c.kind, target: c.target, module: c.module, func: c.func, file: c.file }))
    expect(conns).toEqual([
      { kind: 'sqlite', target: 'notes.db', module: 'legacy', func: 'setup', file: 'notes.db' },
      { kind: 'postgres', target: 'postgresql://app:***@db.example.com/blog', module: 'models_sa', func: null, file: undefined }
    ])
    expect(JSON.stringify(scan)).not.toContain('hunter2')
  })

  it('where each model is used', () => {
    expect(table('posts').usedBy).toEqual(['models_sa:newest'])
  })
})
