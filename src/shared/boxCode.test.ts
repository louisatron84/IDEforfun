import { describe, expect, it } from 'vitest'
import { newApiBox, newRequest, type ApiBox } from './boxes'
import { blockHash, buildRequest, generateBlock, urlArgs } from './boxCode'

function github(): ApiBox {
  const box = newApiBox([], 'GitHub')
  box.baseUrl = 'https://api.github.com'
  box.auth = { kind: 'bearer', env: 'GITHUB_TOKEN' }
  box.requests[0] = { ...box.requests[0], name: 'users', url: '/users', ticked: ['login', 'plan.name'], recordsPath: [], output: 'github_users.csv' }
  const repos = newRequest(box, 'repos')
  repos.url = '/users/{user name}/repos'
  repos.query = [{ key: 'per_page', value: '30', arg: true }, { key: 'sort', value: 'updated' }]
  repos.testArgs = { user_name: 'octocat' }
  repos.recordsPath = ['items']
  box.requests.push(repos)
  return box
}

describe('URL arguments', () => {
  it('placeholders become Python names, in order', () => {
    expect(urlArgs('/users/{user name}/repos/{Repo}')).toEqual(['user_name', 'repo'])
    expect(urlArgs('/plain')).toEqual([])
  })
})

describe('buildRequest (the test call)', () => {
  it('joins the base URL, fills placeholders, encodes the query and adds auth', () => {
    const box = github()
    const r = buildRequest(box, box.requests[1], { GITHUB_TOKEN: 'secret' })
    expect(r).toEqual({
      method: 'GET',
      url: 'https://api.github.com/users/octocat/repos?per_page=30&sort=updated',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' }
    })
  })

  it('says which variable is missing', () => {
    const box = github()
    expect(buildRequest(box, box.requests[0], {})).toEqual({ error: 'GITHUB_TOKEN is not set: add it to .env' })
  })

  it('query auth, spaces and a JSON body', () => {
    const box = newApiBox([], 'Weather')
    box.auth = { kind: 'query', name: 'appid', env: 'WEATHER_KEY' }
    const req = { ...box.requests[0], method: 'POST' as const, url: 'https://x.org/find', query: [{ key: 'q', value: 'a b' }], body: '{"n": 1}' }
    expect(buildRequest(box, req, { WEATHER_KEY: 'k' })).toEqual({
      method: 'POST',
      url: 'https://x.org/find?q=a+b&appid=k',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{"n": 1}'
    })
    expect(buildRequest(box, { ...req, body: '{bad' }, { WEATHER_KEY: 'k' })).toEqual({ error: "The body isn't valid JSON." })
  })

  it('basic auth', () => {
    const box = newApiBox([], 'X')
    box.auth = { kind: 'basic', userEnv: 'X_USER', passEnv: 'X_PASSWORD' }
    const r = buildRequest(box, { ...box.requests[0], url: 'https://x.org' }, { X_USER: 'u', X_PASSWORD: 'p' })
    expect(r).toMatchObject({ headers: { Authorization: 'Basic dTpw' } })
  })
})

describe('generateBlock', () => {
  const box = github()
  const code = generateBlock(box, { main: true })

  it('is one marked block', () => {
    expect(code.startsWith(`# forge:box ${box.id} (generated, edit in Forge or here)\n`)).toBe(true)
    expect(code.endsWith(`# forge:end ${box.id}\n`)).toBe(true)
    expect(code.split('# forge:box').length).toBe(2)
  })

  it('one function per request, with arguments and the output path', () => {
    expect(code).toContain('def github_users(output_path="github_users.csv"):')
    expect(code).toContain('def github_repos(user_name, per_page="30", output_path="github_repos.csv"):')
    expect(code).toContain('fields = ["login", "plan.name"]')
    expect(code).toContain('records = data["items"]')
    expect(code).toContain('"sort": "updated"')
  })

  it('reads the secret from the environment and never contains it', () => {
    expect(code).toContain('os.environ.get("GITHUB_TOKEN")')
    expect(code).toContain('GITHUB_TOKEN is not set: add it to .env')
    expect(code).not.toContain('secret')
  })

  it('__main__ only for new files', () => {
    expect(code).toContain('if __name__ == "__main__":\n    github_users()\n    github_repos("octocat")\n')
    expect(generateBlock(box, { main: false })).not.toContain('__main__')
  })

  it('blockHash ignores line endings', () => {
    expect(blockHash(code)).toMatch(/^[0-9a-f]{8}$/)
    expect(blockHash(code.replace(/\n/g, '\r\n'))).toBe(blockHash(code))
    expect(blockHash(code + 'x')).not.toBe(blockHash(code))
  })
})
