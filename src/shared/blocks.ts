/**
 * Pipeline blocks: whole steps (read a CSV, filter rows, group, call an API,
 * save...) that are ordinary Python functions. The built-in ones live in
 * forge_blocks.py, which Forge writes next to a pipeline the first time a
 * built-in block is placed (pandas). A project's own blocks are functions
 * marked @block (or any function in a blocks.py). A block's inputs and output
 * come from its parameters, type hints and return value.
 */
import type { SymbolNode, ProjectGraph } from './projectGraph'

export const BLOCKS_FILE = 'forge_blocks.py'
export const BLOCKS_VERSION = 1

export const BLOCKS_PY = String.raw`# forge:blocks 1
"""Forge's built-in pipeline blocks: ordinary Python functions, using pandas.

Forge keeps this file up to date. To change a block, choose Edit on it in
Forge's Pipeline view: the block is copied into your project's blocks.py
first, so updates to this file never overwrite your version.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

import pandas as pd


def block(fn):
    """Mark a function as a pipeline block: Forge lists it in the block library."""
    fn.__forge_block__ = True
    return fn


@block
def read_csv(path: str) -> pd.DataFrame:
    """Read a CSV file into a table."""
    return pd.read_csv(path)


@block
def read_json(path: str, records_path: Optional[str] = None) -> pd.DataFrame:
    """Read a JSON file (a list of records, or records under a key such as "data.items") into a table."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return _records_table(data, records_path)


@block
def call_api(url: str, params: Optional[dict] = None, records_path: Optional[str] = None) -> pd.DataFrame:
    """GET a JSON web API and turn the records it returns into a table."""
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read())
    return _records_table(data, records_path)


@block
def filter_rows(table: pd.DataFrame, condition: str) -> pd.DataFrame:
    """Keep the rows where the condition holds, e.g. "amount > 100 and status == 'paid'"."""
    return table.query(condition).reset_index(drop=True)


@block
def select_columns(table: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    """Keep only these columns, in this order."""
    return table[list(columns)]


@block
def rename_columns(table: pd.DataFrame, names: dict[str, str]) -> pd.DataFrame:
    """Rename columns: {"old name": "new name"}."""
    return table.rename(columns=names)


@block
def add_column(table: pd.DataFrame, name: str, expression: str) -> pd.DataFrame:
    """Add (or replace) a column worked out from others, e.g. "price * quantity"."""
    out = table.copy()
    out[name] = out.eval(expression)
    return out


@block
def sort_rows(table: pd.DataFrame, by: list[str], descending: bool = False) -> pd.DataFrame:
    """Sort the rows by these columns."""
    return table.sort_values(list(by), ascending=not descending).reset_index(drop=True)


@block
def group_by(table: pd.DataFrame, by: list[str], totals: dict[str, str]) -> pd.DataFrame:
    """Group the rows and total columns, e.g. by ["region"] with totals {"amount": "sum"}."""
    return table.groupby(list(by), as_index=False).agg(totals)


@block
def merge(left: pd.DataFrame, right: pd.DataFrame, on: list[str], how: str = "inner") -> pd.DataFrame:
    """Join two tables on matching columns (how: "inner", "left", "right" or "outer")."""
    return left.merge(right, on=list(on), how=how)


@block
def drop_duplicates(table: pd.DataFrame, columns: Optional[list[str]] = None) -> pd.DataFrame:
    """Remove repeated rows (judged on these columns, or all of them)."""
    return table.drop_duplicates(subset=columns).reset_index(drop=True)


@block
def fill_missing(table: pd.DataFrame, value: Any = 0) -> pd.DataFrame:
    """Fill empty cells with a value."""
    return table.fillna(value)


@block
def retry(step: Callable, *args: Any, attempts: int = 3, wait_seconds: float = 1.0, **kwargs: Any) -> Any:
    """Run a step, trying again if it fails (e.g. a flaky web API), waiting a little longer each time."""
    for attempt in range(1, attempts + 1):
        try:
            return step(*args, **kwargs)
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(wait_seconds * attempt)


@block
def save_csv(table: pd.DataFrame, path: str) -> str:
    """Save a table as a CSV file; returns the path."""
    table.to_csv(path, index=False)
    return path


@block
def save_json(table: pd.DataFrame, path: str) -> str:
    """Save a table as a JSON list of records; returns the path."""
    table.to_json(path, orient="records", indent=2)
    return path


def _records_table(data: Any, records_path: Optional[str] = None) -> pd.DataFrame:
    """The records in some JSON (at records_path, or the largest list in it) as a table."""
    if records_path:
        for key in records_path.split("."):
            data = data[key]
    elif isinstance(data, dict):
        lists = [v for v in data.values() if isinstance(v, list)]
        if lists:
            data = max(lists, key=len)
    return pd.json_normalize(data)
`

export type BlockKind = 'read' | 'api' | 'filter' | 'select' | 'transform' | 'group' | 'merge' | 'save' | 'retry' | 'other'

export interface BlockParam {
  name: string
  annotation: string | null
  default: string | null
}

export interface BlockInfo {
  name: string
  kind: BlockKind
  doc: string
  params: BlockParam[]
  returns: string | null
  /** 'builtin': forge_blocks.py; 'project': a function in the project. */
  source: 'builtin' | 'project'
  /** Project blocks: where it is. */
  module?: string
  path?: string
  line?: number
}

const KINDS: Record<string, BlockKind> = {
  read_csv: 'read', read_json: 'read', call_api: 'api', filter_rows: 'filter', select_columns: 'select', rename_columns: 'transform',
  add_column: 'transform', sort_rows: 'transform', group_by: 'group', merge: 'merge', drop_duplicates: 'filter', fill_missing: 'transform',
  retry: 'retry', save_csv: 'save', save_json: 'save'
}

/** A guess at what a project block does, from its name. */
export function kindOf(name: string): BlockKind {
  if (KINDS[name]) return KINDS[name]
  if (/^(read|load|open|fetch_file)/.test(name)) return 'read'
  if (/(api|fetch|request|download)/.test(name)) return 'api'
  if (/^(filter|keep|drop|remove|where)/.test(name)) return 'filter'
  if (/(group|aggregate|total|summar)/.test(name)) return 'group'
  if (/(merge|join|combine)/.test(name)) return 'merge'
  if (/^(save|write|export|store)/.test(name)) return 'save'
  return 'transform'
}

/** The built-in blocks, read from forge_blocks.py's source. */
export function builtinBlocks(): BlockInfo[] {
  const out: BlockInfo[] = []
  const re = /@block\ndef (\w+)\(([^)]*)\)(?: -> ([^:]+))?:\n {4}"""([^\n]*)"""/g
  for (const m of BLOCKS_PY.replace(/\r\n/g, '\n').matchAll(re)) {
    out.push({ name: m[1], kind: kindOf(m[1]), doc: m[4].trim(), params: parseParams(m[2]), returns: m[3]?.trim() ?? null, source: 'builtin' })
  }
  return out
}

/** "a: int, b: str = 'x', *args: Any" → params (split at top-level commas only). */
export function parseParams(text: string): BlockParam[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  let quote: string | null = null
  for (const ch of text) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
    const eq = splitTop(p, '=')
    const head = eq[0].trim()
    const colon = splitTop(head, ':')
    return { name: colon[0].trim(), annotation: colon.length > 1 ? colon.slice(1).join(':').trim() : null, default: eq.length > 1 ? eq.slice(1).join('=').trim() : null }
  })
}

function splitTop(text: string, sep: string): string[] {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === sep && depth === 0) return [text.slice(0, i), text.slice(i + 1)]
  }
  return [text]
}

/** One built-in block's source (decorator to the end of the function), for copying into the project. */
export function builtinSource(name: string): string | null {
  const text = BLOCKS_PY.replace(/\r\n/g, '\n')
  const start = text.indexOf(`@block\ndef ${name}(`)
  if (start < 0) return null
  const rest = text.slice(start)
  const end = rest.slice(1).search(/\n\n\n(?=@block|def |class )/)
  return end < 0 ? rest.trimEnd() + '\n' : rest.slice(0, end + 1) + '\n'
}

/** The project's own blocks: functions marked @block, or any public function in a module named blocks. */
export function projectBlocks(graph: ProjectGraph): BlockInfo[] {
  const out: BlockInfo[] = []
  for (const m of graph.modules) {
    if (m.id === 'forge_blocks' || m.id.endsWith('.forge_blocks')) continue
    const blocksModule = m.id === 'blocks' || m.id.endsWith('.blocks')
    for (const s of m.symbols as SymbolNode[]) {
      if (s.kind !== 'function' || s.qual.includes('.')) continue
      const marked = s.decorators.some((d) => d === 'block' || d.endsWith('.block'))
      if (!marked && !(blocksModule && !s.name.startsWith('_'))) continue
      out.push({
        name: s.name, kind: kindOf(s.name), doc: s.doc ?? '', params: (s.params ?? []).map((p) => ({ ...p })), returns: s.returns ?? null,
        source: 'project', module: m.id, path: m.path, line: s.line
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Does the data flow into this parameter (a table or value from an earlier step), rather than being a setting? */
export function isDataParam(p: BlockParam, index: number): boolean {
  if (p.name.startsWith('*')) return false
  if (p.annotation && /DataFrame|Series|list\[dict|Iterable|Sequence/.test(p.annotation) && !/^(str|int|float|bool)\b/.test(p.annotation)) return true
  return index === 0 && /^(table|df|data|frame|records|rows|items|left|right|values)$/.test(p.name)
}
