import { describe, expect, it } from 'vitest'
import { compareRuns, endpointOf, filterRecords, groupRecords, isSlow, NetLog, parseNet, stateOf, timelineLanes, type NetRecord } from './network'

const rec = (over: Partial<NetRecord>): NetRecord => ({
  id: 1, kind: 'http', lib: 'requests', method: 'GET', url: 'https://api.example.com/users', host: 'api.example.com',
  status: 200, error: null, start: 0, ms: 50, func: 'app.api:fetch', reqHeaders: [], respHeaders: [], reqBody: null, respBody: null, size: null,
  ...over
})

describe('parseNet', () => {
  it('reads a tracer net message', () => {
    const r = rec({ id: 7 })
    expect(parseNet({ t: 'net', r })).toEqual(r)
  })
  it('rejects other messages and malformed records', () => {
    expect(parseNet({ t: 'tick', at: null, calls: [] })).toBeNull()
    expect(parseNet({ t: 'net', r: { ...rec({}), id: 'x' } })).toBeNull()
    expect(parseNet({ t: 'net', r: { ...rec({}), kind: 'ftp' } })).toBeNull()
    expect(parseNet(null)).toBeNull()
  })
  it('drops bad header pairs instead of failing', () => {
    const r = parseNet({ t: 'net', r: { ...rec({}), reqHeaders: [['a', 'b'], ['bad'], 3] } })
    expect(r?.reqHeaders).toEqual([['a', 'b']])
  })
})

describe('state, slowness and endpoints', () => {
  it('is pending until finished, failed on errors and 4xx/5xx', () => {
    expect(stateOf(rec({ ms: null, status: null }))).toBe('pending')
    expect(stateOf(rec({ status: 200 }))).toBe('ok')
    expect(stateOf(rec({ status: 304 }))).toBe('ok')
    expect(stateOf(rec({ status: 404 }))).toBe('failed')
    expect(stateOf(rec({ status: null, error: 'ConnectionRefusedError: x' }))).toBe('failed')
    expect(stateOf(rec({ kind: 'socket', status: null, method: 'CONNECT' }))).toBe('ok')
  })
  it('slow means a second or more', () => {
    expect(isSlow(rec({ ms: 999 }))).toBe(false)
    expect(isSlow(rec({ ms: 1000 }))).toBe(true)
    expect(isSlow(rec({ ms: null }))).toBe(false)
  })
  it('an endpoint ignores the query and numbers in the path', () => {
    expect(endpointOf(rec({ url: 'https://api.example.com/users/42/posts?page=2' }))).toBe('GET api.example.com/users/{n}/posts')
    expect(endpointOf(rec({ url: 'https://api.example.com/items/3f2b1c9e-0d6a-4c3f-9a1b-2b3c4d5e6f70' }))).toBe('GET api.example.com/items/{id}')
    expect(endpointOf(rec({ kind: 'socket', method: 'CONNECT', url: 'db.local:5432', host: 'db.local' }))).toBe('CONNECT db.local:5432')
  })
})

describe('filter and group', () => {
  const recs = [
    rec({ id: 1, url: 'https://api.example.com/users', status: 200, ms: 40 }),
    rec({ id: 2, url: 'https://api.example.com/orders', status: 500, ms: 80, func: 'app.api:orders' }),
    rec({ id: 3, url: 'https://hooks.slack.com/x', host: 'hooks.slack.com', method: 'POST', status: 200, ms: 1500, func: null })
  ]
  it('filters by text (url, method, status, function) and by failed / slow', () => {
    expect(filterRecords(recs, { text: 'slack', only: 'all' }).map((r) => r.id)).toEqual([3])
    expect(filterRecords(recs, { text: 'post', only: 'all' }).map((r) => r.id)).toEqual([3])
    expect(filterRecords(recs, { text: '500', only: 'all' }).map((r) => r.id)).toEqual([2])
    expect(filterRecords(recs, { text: 'orders', only: 'all' }).map((r) => r.id)).toEqual([2])
    expect(filterRecords(recs, { text: '', only: 'failed' }).map((r) => r.id)).toEqual([2])
    expect(filterRecords(recs, { text: '', only: 'slow' }).map((r) => r.id)).toEqual([3])
  })
  it('groups by host or by the function that made the request', () => {
    expect(groupRecords(recs, 'host').map((g) => `${g.label}:${g.records.length}:${g.failed}`)).toEqual(['api.example.com:2:1', 'hooks.slack.com:1:0'])
    expect(groupRecords(recs, 'func').map((g) => `${g.label}:${g.records.length}`)).toEqual(['app.api.fetch:1', 'app.api.orders:1', '(outside your code):1'])
    expect(groupRecords(recs, 'none')).toEqual([{ key: '', label: '', records: recs, failed: 1, slowest: 1500 }])
  })
})

describe('timelineLanes', () => {
  it('puts requests that overlap in time on separate lanes', () => {
    const lanes = timelineLanes([
      rec({ id: 1, start: 0, ms: 100 }),
      rec({ id: 2, start: 50, ms: 100 }),
      rec({ id: 3, start: 120, ms: 10 }),
      rec({ id: 4, start: 130, ms: null })
    ], 200)
    expect(lanes.map((l) => `${l.id}@${l.lane}`)).toEqual(['1@0', '2@1', '3@0', '4@0'])
    // Pending requests run to "now".
    expect(lanes[3].end).toBe(200)
  })
})

describe('compareRuns', () => {
  it('lists endpoints that are new, gone, slower, faster or failing more', () => {
    const before = [
      rec({ id: 1, url: 'https://a.com/users/1', ms: 100 }),
      rec({ id: 2, url: 'https://a.com/users/2', ms: 100 }),
      rec({ id: 3, url: 'https://a.com/old', ms: 10 }),
      rec({ id: 4, url: 'https://a.com/fast', ms: 900 }),
      rec({ id: 5, url: 'https://a.com/flaky', ms: 10 })
    ]
    const after = [
      rec({ id: 1, url: 'https://a.com/users/3', ms: 400 }),
      rec({ id: 2, url: 'https://a.com/new', ms: 10 }),
      rec({ id: 3, url: 'https://a.com/fast', ms: 100 }),
      rec({ id: 4, url: 'https://a.com/flaky', ms: 10, status: 503 })
    ]
    const rows = compareRuns(before, after)
    const show = (e: string) => {
      const r = rows.find((x) => x.endpoint === e)!
      return `${r.change} ${r.before.count}->${r.after.count}`
    }
    expect(show('GET a.com/users/{n}')).toBe('slower 2->1')
    expect(show('GET a.com/new')).toBe('new 0->1')
    expect(show('GET a.com/old')).toBe('gone 1->0')
    expect(show('GET a.com/fast')).toBe('faster 1->1')
    expect(show('GET a.com/flaky')).toBe('failing 1->1')
    // Changes first, unchanged last.
    expect(rows[rows.length - 1].change === 'same' || rows.every((r) => r.change !== 'same')).toBe(true)
  })
})

describe('NetLog', () => {
  it('keeps this run and the one before, updating records by id', () => {
    const log = new NetLog()
    log.begin(1)
    log.upsert(rec({ id: 1, status: null, ms: null }))
    log.upsert(rec({ id: 1, status: 200, ms: 30 }))
    expect(log.current.map((r) => r.status)).toEqual([200])
    log.begin(2)
    log.upsert(rec({ id: 1, url: 'https://x.com/' }))
    expect(log.previous.map((r) => r.url)).toEqual(['https://api.example.com/users'])
    expect(log.current.map((r) => r.url)).toEqual(['https://x.com/'])
    log.begin(3)
    expect(log.previous.map((r) => r.url)).toEqual(['https://x.com/'])
    expect(log.current).toEqual([])
  })
  it('a run with no requests does not replace the previous one to compare with', () => {
    const log = new NetLog()
    log.begin(1)
    log.upsert(rec({ id: 1 }))
    log.begin(2)
    log.begin(3)
    expect(log.previous.length).toBe(1)
  })
})
