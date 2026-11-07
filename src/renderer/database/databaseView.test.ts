// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { DbSchema } from '../../shared/database'
import { DatabaseView } from './databaseView'

const schema: DbSchema = {
  tables: [
    { id: 'posts', name: 'posts', model: 'Post', framework: 'sqlalchemy', module: 'models', path: 'models.py', line: 12, sources: ['model'], usedBy: ['app:newest'],
      columns: [{ name: 'id', type: 'int', pk: true }, { name: 'author_id', type: 'int', fk: 'users' }] },
    { id: 'users', name: 'users', model: 'User', framework: 'sqlalchemy', module: 'models', path: 'models.py', line: 5, sources: ['model', 'database'], usedBy: [],
      columns: [{ name: 'id', type: 'int', pk: true }, { name: 'name', type: 'String(50)' }] }
  ],
  relations: [{ from: 'posts', to: 'users', kind: 'fk', column: 'author_id' }],
  connections: [{ kind: 'sqlite', library: 'sqlite3', target: 'app.db', module: 'db', path: 'db.py', func: 'connect', line: 4, file: 'app.db' }]
}

function setup(result: { schema?: DbSchema; error?: string } = { schema }) {
  const opened: string[] = []
  const view = new DatabaseView({
    scan: async () => result,
    openAt: (path, line) => void opened.push(`${path}:${line}`),
    openFunction: (id) => void opened.push(id)
  })
  document.body.replaceChildren(view.el)
  return { view, opened }
}
const side = () => document.querySelector('.db-side')!.textContent!
const items = (text: string) => [...document.querySelectorAll<HTMLElement>('.db-side .graph-item')].find((e) => e.textContent!.includes(text))!

describe('Database explorer', () => {
  it('says what it looks for when the project has no database code', async () => {
    const { view } = setup({ schema: { tables: [], relations: [], connections: [] } })
    await view.refresh()
    expect(document.querySelector('.db-note')!.textContent).toContain('SQLAlchemy, SQLModel, Django and Peewee models')
  })

  it('draws each table with its columns and keys, and a line for each foreign key', async () => {
    const { view } = setup()
    await view.refresh()
    const posts = document.querySelector('.dbtable[data-id="posts"]')!
    expect([...posts.querySelectorAll('.dbcol-name')].map((e) => e.textContent)).toEqual(['id', 'author_id'])
    expect(posts.querySelector('.dbrow.pk')).not.toBeNull()
    expect(posts.querySelector('.dbrow.fk .dbcol-type')!.textContent).toBe('→ users')
    expect(document.querySelectorAll('.dbedge.k-fk').length).toBe(1)
  })

  it('lists the connections; clicking one opens the code', async () => {
    const { view, opened } = setup()
    await view.refresh()
    expect(side()).toContain('Connections (1)')
    items('app.db').click()
    expect(opened).toEqual(['db.py:3'])
  })

  it('a table\'s details: where it is defined, its keys, what refers to it, where the model is used', async () => {
    const { view, opened } = setup()
    await view.refresh()
    view.select('posts')
    expect(side()).toContain('Defined by the Post model (SQLAlchemy) in models.py')
    expect(side()).toContain('Refers to')
    items('app.newest').click()
    expect(opened).toEqual(['app:newest'])
    view.select('users')
    expect(side()).toContain('Also in the database file')
    expect(side()).toContain('Referred to by')
  })

  it('shows why the analysis failed', async () => {
    const { view } = setup({ error: 'Python was not found' })
    await view.refresh()
    expect(document.querySelector('.db-note')!.textContent).toContain('Python was not found')
  })
})
