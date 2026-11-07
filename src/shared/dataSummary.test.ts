import { describe, expect, it } from 'vitest'
import { change, DataLog, parseDataMessage, summaryText, type Summary } from './dataSummary'

const df = (rows: number, cols: string[]): Summary => ({ type: 'pandas.DataFrame', kind: 'dataframe', shape: [rows, cols.length], columns: cols.map((c) => [c, 'int64']), rows: [] })

describe('summaryText', () => {
  it('describes each kind of value briefly', () => {
    expect(summaryText(df(1204, ['a', 'b', 'c']))).toBe('table: 1,204 rows × 3 columns')
    expect(summaryText({ type: 'pandas.Series', kind: 'series', shape: [10], dtype: 'float64' })).toBe('column: 10 values (float64)')
    expect(summaryText({ type: 'list', kind: 'sequence', len: 3 })).toBe('list of 3')
    expect(summaryText({ type: 'dict', kind: 'mapping', len: 1 })).toBe('dict of 1')
    expect(summaryText({ type: 'int', kind: 'value', repr: '42' })).toBe('42')
  })
})

describe('change', () => {
  it('rows kept or lost, columns added or removed', () => {
    expect(change(df(1204, ['a', 'b']), df(873, ['a', 'b']), 'filter')).toBe('1,204 → 873 rows (−331)')
    expect(change(df(10, ['a', 'b']), df(10, ['a', 'b', 'total']), 'transform')).toBe('+1 column: total')
    expect(change(df(10, ['a', 'b', 'c']), df(10, ['a']), 'select')).toBe('−2 columns: b, c')
    expect(change(df(100, ['region', 'amount']), df(4, ['region', 'amount']), 'group')).toBe('100 rows → 4 groups')
    expect(change(df(5, ['a']), df(5, ['a']), 'transform')).toBe('')
    expect(change(null, df(5, ['a']), 'read')).toBe('')
  })
})

describe('parseDataMessage', () => {
  it('reads data and io messages; rejects others', () => {
    expect(parseDataMessage({ t: 'data', func: 'm:f', line: 3, var: 'x', n: 1, summary: { type: 'int', kind: 'value', repr: '1' } }))
      .toEqual({ kind: 'data', func: 'm:f', line: 3, var: 'x', n: 1, summary: { type: 'int', kind: 'value', repr: '1' } })
    expect(parseDataMessage({ t: 'io', io: { func: 'm:g', total: 3, calls: [{ in: { a: { type: 'int', kind: 'value', repr: '1' } }, out: null }] } }))
      .toEqual({ kind: 'io', io: { func: 'm:g', total: 3, calls: [{ in: { a: { type: 'int', kind: 'value', repr: '1' } }, out: null }] } })
    expect(parseDataMessage({ t: 'data', func: 'm:f' })).toBeNull()
    expect(parseDataMessage({ t: 'tick' })).toBeNull()
  })
})

describe('DataLog', () => {
  it('keeps this run\'s values by line, the last per variable, and function inputs/outputs', () => {
    const log = new DataLog()
    log.begin(1)
    log.add(parseDataMessage({ t: 'data', func: 'm:f', line: 3, var: 'x', n: 1, summary: { type: 'int', kind: 'value', repr: '1' } })!)
    log.add(parseDataMessage({ t: 'data', func: 'm:f', line: 3, var: 'x', n: 2, summary: { type: 'int', kind: 'value', repr: '2' } })!)
    log.add(parseDataMessage({ t: 'io', io: { func: 'm:g', total: 1, calls: [] } })!)
    expect(log.at('m:f', 3)).toEqual([{ var: 'x', n: 2, summary: { type: 'int', kind: 'value', repr: '2' } }])
    expect(log.io('m:g')?.total).toBe(1)
    expect(log.func).toBe('m:f')
    log.begin(2)
    expect(log.at('m:f', 3)).toEqual([])
  })
})
