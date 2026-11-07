/**
 * Context-aware tools: from what you're doing (the open file, the task, a
 * run or debug session, problems, changes), the few tools that would help
 * right now, shown as suggestions in the top bar. Panels already on screen
 * aren't suggested.
 */

export interface WorkContext {
  task: 'code' | 'connect' | 'debug' | 'run'
  /** The Python file in the editor (path and text), if any. */
  file: { path: string; text: string } | null
  debug: 'idle' | 'starting' | 'running' | 'paused'
  /** The last run ended with an error (and nothing ran since). */
  lastRunFailed: boolean
  /** Errors and warnings in the open file. */
  problems: number
  /** Changed files in Git. */
  changes: number
  shown(panel: string): boolean
}

export interface Suggestion {
  id: string
  label: string
  why: string
  /** Show a panel, or run a command. */
  panel?: string
  command?: string
}

const WEB = /^\s*(import|from)\s+(requests|httpx|aiohttp|urllib\.request|urllib3)\b/m
const TABLES = /^\s*(import|from)\s+(pandas|polars|forge_blocks)\b/m
const DATABASE = /^\s*(import|from)\s+(sqlite3|aiosqlite|sqlalchemy|sqlmodel|peewee|psycopg2?|asyncpg|pymysql|pymongo|redis|django\.db)\b/m
const TESTS = /(^|[\\/])(test_[^\\/]*|[^\\/]*_test)\.py$/i

export function suggestTools(ctx: WorkContext, max = 3): Suggestion[] {
  const out: Suggestion[] = []
  const add = (s: Suggestion) => {
    if (s.panel && ctx.shown(s.panel)) return
    if (!out.some((x) => x.id === s.id)) out.push(s)
  }
  const f = ctx.file
  if (ctx.debug === 'paused') add({ id: 'debug', label: 'Debug', why: 'Paused: see the call stack and variables', panel: 'debug' })
  if (ctx.lastRunFailed && ctx.debug === 'idle') add({ id: 'debug-it', label: 'Debug it', why: 'The last run failed: run it again in the debugger', command: 'debug.start' })
  if (ctx.problems > 0) add({ id: 'problems', label: `Problems (${ctx.problems})`, why: `${ctx.problems} problem${ctx.problems === 1 ? '' : 's'} in this file`, panel: 'problems' })
  if (f) {
    if (TESTS.test(f.path) || /^\s*def test_/m.test(f.text)) add({ id: 'tests', label: 'Tests', why: 'This file has tests: run them and see the results', panel: 'tests' })
    if (WEB.test(f.text)) add({ id: 'network', label: 'Network', why: 'This file calls web APIs: see each request while it runs', panel: 'network' })
    if (DATABASE.test(f.text)) add({ id: 'database', label: 'Database', why: 'This file uses a database: see its tables, keys and connections', panel: 'database' })
    if (TABLES.test(f.text)) add({ id: 'pipeline', label: 'Pipeline', why: 'This file works with tables: see its steps and the data at each one', panel: 'pipeline' })
  }
  if (ctx.changes > 0 && ctx.task === 'code') add({ id: 'git', label: `Git (${ctx.changes})`, why: `${ctx.changes} changed file${ctx.changes === 1 ? '' : 's'} to commit`, panel: 'git' })
  return out.slice(0, max)
}
