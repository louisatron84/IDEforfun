import { describe, expect, it } from 'vitest'
import { suggestTools, type WorkContext } from './suggest'

const ctx = (over: Partial<WorkContext>): WorkContext => ({
  task: 'code', file: null, debug: 'idle', lastRunFailed: false, problems: 0, changes: 0, shown: () => false, ...over
})
const ids = (c: WorkContext) => suggestTools(c).map((s) => s.id)

describe('suggestTools', () => {
  it('nothing when nothing is going on', () => {
    expect(ids(ctx({}))).toEqual([])
  })
  it('from the open file: web APIs, tables, tests', () => {
    expect(ids(ctx({ file: { path: 'app/api.py', text: 'import requests\n' } }))).toEqual(['network'])
    expect(ids(ctx({ file: { path: 'etl.py', text: 'import pandas as pd\n' } }))).toEqual(['pipeline'])
    expect(ids(ctx({ file: { path: 'tests/test_x.py', text: 'from forge_blocks import read_csv\n' } }))).toEqual(['tests', 'pipeline'])
  })
  it('a file that uses a database suggests the Database panel', () => {
    expect(ids(ctx({ file: { path: 'db.py', text: 'import sqlite3\n' } }))).toEqual(['database'])
    expect(ids(ctx({ file: { path: 'models.py', text: 'from sqlalchemy.orm import Mapped\n' } }))).toEqual(['database'])
    expect(ids(ctx({ file: { path: 'shop/models.py', text: 'from django.db import models\n' } }))).toEqual(['database'])
    expect(ids(ctx({ file: { path: 'x.py', text: 'import sqlite3\n' }, shown: (p) => p === 'database' }))).toEqual([])
  })
  it('a failed run suggests debugging it; a pause, the Debug panel', () => {
    expect(ids(ctx({ lastRunFailed: true }))).toEqual(['debug-it'])
    expect(ids(ctx({ debug: 'paused', lastRunFailed: true }))).toEqual(['debug'])
  })
  it('problems and changes, at most three, most urgent first; panels on screen are skipped', () => {
    const busy = ctx({ problems: 2, changes: 5, lastRunFailed: true, file: { path: 'a.py', text: 'import httpx\nimport pandas\n' } })
    expect(ids(busy)).toEqual(['debug-it', 'problems', 'network'])
    expect(ids({ ...busy, shown: (p) => p === 'problems' || p === 'network' })).toEqual(['debug-it', 'pipeline', 'git'])
    expect(suggestTools(busy)[1].label).toBe('Problems (2)')
  })
})
