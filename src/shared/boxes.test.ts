import { describe, expect, it } from 'vitest'
import { envName, functionNameFor, moduleOfPath, newApiBox, newRequest, normalizeBoxes, pyName, renameBox, serializeBoxes } from './boxes'

describe('box names', () => {
  it('pyName makes valid Python names', () => {
    expect(pyName('My API!')).toBe('my_api')
    expect(pyName('2nd list')).toBe('_2nd_list')
    expect(pyName('  GitHub -- Users ')).toBe('github_users')
    expect(pyName('')).toBe('api')
    expect(pyName('!!!')).toBe('api')
  })

  it('envName makes environment variable names', () => {
    expect(envName('GitHub', 'TOKEN')).toBe('GITHUB_TOKEN')
    expect(envName('My API!', 'KEY')).toBe('MY_API_KEY')
  })

  it('functionNameFor joins box and request names unless one is set', () => {
    const box = newApiBox([], 'GitHub')
    const req = { ...box.requests[0], name: 'users' }
    expect(functionNameFor(box, req)).toBe('github_users')
    expect(functionNameFor(box, { ...req, functionName: 'Get Users' })).toBe('get_users')
  })
})

describe('new boxes', () => {
  it('newApiBox has sensible defaults', () => {
    const box = newApiBox([], 'GitHub')
    expect(box.type).toBe('api')
    expect(box.auth).toEqual({ kind: 'none' })
    expect(box.target).toEqual({ file: 'api/github.py', mode: 'new' })
    expect(box.requests).toHaveLength(1)
    expect(box.requests[0]).toMatchObject({ name: 'data', method: 'GET', output: 'github_data.csv', ticked: [], recordsPath: null })
    expect(box.hash).toBeNull()
    expect(box.detached).toBe(false)
  })

  it('ids are unique', () => {
    const a = newApiBox([], 'GitHub')
    const b = newApiBox([a.id], 'GitHub')
    expect(b.id).not.toBe(a.id)
    const r = newRequest(a)
    expect(a.requests.map((x) => x.id)).not.toContain(r.id)
  })
})

describe('renaming and moving', () => {
  it('moduleOfPath', () => {
    expect(moduleOfPath('api/github.py')).toBe('api.github')
    expect(moduleOfPath('pkg\\sub\\__init__.py')).toBe('pkg.sub')
    expect(moduleOfPath('main.py')).toBe('main')
  })

  it('renameBox moves default names along until the code is written', () => {
    const box = newApiBox([], 'API')
    box.attach = { module: 'api.api' }
    renameBox(box, 'GitHub')
    expect(box.name).toBe('GitHub')
    expect(box.target.file).toBe('api/github.py')
    expect(box.attach).toEqual({ module: 'api.github' })
    expect(box.requests[0].output).toBe('github_data.csv')
    box.requests[0].output = 'mine.csv'
    box.hash = 'abc'
    renameBox(box, 'Hub')
    expect(box.target.file).toBe('api/github.py')
    expect(box.requests[0].output).toBe('mine.csv')
  })
})

describe('boxes.json', () => {
  it('normalizeBoxes drops junk and fixes fields', () => {
    const good = newApiBox([], 'GitHub')
    const boxes = normalizeBoxes({
      version: 1,
      boxes: [
        42,
        { type: 'database', id: 'x' },
        { ...good, hash: 'abc', detached: true, requests: [{ ...good.requests[0], method: 'FETCH' }] },
        { ...good }
      ]
    })
    expect(boxes).toHaveLength(2)
    expect(boxes[0].requests[0].method).toBe('GET')
    expect(boxes[0].hash).toBe('abc')
    expect(boxes[0].detached).toBe(true)
    expect(boxes[1].id).not.toBe(boxes[0].id)
  })

  it('normalizeBoxes accepts nothing', () => {
    expect(normalizeBoxes(undefined)).toEqual([])
    expect(normalizeBoxes({ boxes: 'no' })).toEqual([])
  })

  it('serializeBoxes round-trips and leaves out response samples', () => {
    const box = newApiBox([], 'GitHub')
    box.auth = { kind: 'bearer', env: 'GITHUB_TOKEN' }
    box.requests[0].test = {
      ok: true, at: 1, status: 200, count: 1, ms: 5, sample: [{ secret: 'x' }],
      fields: [{ path: ['email'], name: 'email', kind: 'value', sample: 'ann@private.example', children: [] }]
    }
    const file = serializeBoxes([box])
    expect(file.version).toBe(1)
    expect(JSON.stringify(file)).not.toContain('secret')
    // Nothing from the response is saved (it could end up in git): a new test call brings the fields back.
    expect(JSON.stringify(file)).not.toContain('ann@private.example')
    expect(file.boxes[0].requests[0].test!.fields).toBeUndefined()
    const back = normalizeBoxes(JSON.parse(JSON.stringify(file)))
    expect(back[0].auth).toEqual({ kind: 'bearer', env: 'GITHUB_TOKEN' })
    expect(back[0].requests[0].test).toMatchObject({ ok: true, status: 200 })
  })
})
