/**
 * OpenAPI import: reading OpenAPI 3 / Swagger 2, the generated client (and
 * running it with a real Python against a small local server), edit
 * detection and adding imports.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envKeys, pyClass, pyIdent, readSpec } from '../shared/openapi'
import { addImport, generateClient, generatedState, importLine } from '../shared/openapiCode'

const PETSTORE = {
  openapi: '3.0.3',
  info: { title: 'Petstore API', version: '1.2.0', description: 'Pets.\nMore.' },
  servers: [{ url: 'https://{region}.pets.example.com/v1/', variables: { region: { default: 'eu' } } }],
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
    schemas: {
      Owner: { type: 'object', properties: { name: { type: 'string' } } },
      Pet: {
        type: 'object', required: ['id', 'name'], description: 'A pet.',
        properties: {
          id: { type: 'integer' }, name: { type: 'string' }, tag: { type: 'string', description: 'Free text' },
          owner: { $ref: '#/components/schemas/Owner' }, 'photo-urls': { type: 'array', items: { type: 'string' } },
          class: { type: 'string' }
        }
      },
      NewPet: { allOf: [{ $ref: '#/components/schemas/Owner' }, { type: 'object', required: ['petName'], properties: { petName: { type: 'string' } } }] },
      Pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }
    },
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } }
  },
  paths: {
    '/pets': {
      get: { operationId: 'listPets', summary: 'List pets', tags: ['pets'], parameters: [{ $ref: '#/components/parameters/Limit' }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pets' } } } } } },
      post: { operationId: 'createPet', tags: ['pets'], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } }, responses: { 201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } }
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'showPetById', parameters: [{ name: 'X-Trace', in: 'header', schema: { type: 'string' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      delete: { responses: { 204: { description: 'gone' } } }
    }
  }
}

const SWAGGER = {
  swagger: '2.0',
  info: { title: 'Old Shop', version: '1' },
  host: 'shop.example.com', basePath: '/api', schemes: ['http', 'https'],
  securityDefinitions: { basic: { type: 'basic' }, key: { type: 'apiKey', in: 'query', name: 'api_key' } },
  definitions: { Item: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, price: { type: 'number' } } } },
  paths: {
    '/items': {
      post: { operationId: 'addItem', parameters: [{ name: 'item', in: 'body', required: true, schema: { $ref: '#/definitions/Item' } }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Item' } } } }
    },
    '/login': {
      post: { operationId: 'login', parameters: [{ name: 'user', in: 'formData', type: 'string' }, { name: 'pass', in: 'formData', type: 'string' }], responses: { 200: { description: 'ok' } } }
    }
  }
}

describe('names', () => {
  it('pyIdent and pyClass make valid Python names', () => {
    expect(pyIdent('petId')).toBe('pet_id')
    expect(pyIdent('photo-urls')).toBe('photo_urls')
    expect(pyIdent('class')).toBe('class_')
    expect(pyIdent('HTTPStatus')).toBe('http_status')
    expect(pyIdent('$$')).toBe('value')
    expect(pyClass('user-profile')).toBe('UserProfile')
    expect(pyClass('2fa')).toBe('M2fa')
  })
})

describe('readSpec: OpenAPI 3', () => {
  const spec = readSpec(PETSTORE)
  it('reads the title, base address (server variables filled in) and names', () => {
    expect(spec.title).toBe('Petstore API')
    expect(spec.baseUrl).toBe('https://eu.pets.example.com/v1')
    expect(spec.slug).toBe('petstore')
    expect(spec.envPrefix).toBe('PETSTORE')
    expect(spec.description).toBe('Pets.')
  })
  it('reads the authentication schemes as environment variables', () => {
    expect(spec.auth).toEqual([{ kind: 'bearer', env: 'PETSTORE_TOKEN' }, { kind: 'apiKey', in: 'header', name: 'X-Api-Key', env: 'PETSTORE_API_KEY' }])
    expect(envKeys(spec)).toEqual(['PETSTORE_BASE_URL', 'PETSTORE_TOKEN', 'PETSTORE_API_KEY'])
  })
  it('reads models, merging allOf, with Python field names', () => {
    const pet = spec.models.find((m) => m.name === 'Pet')!
    expect(pet.fields.map((f) => `${f.name}:${f.py}:${f.type.kind}:${f.required}`)).toEqual([
      'id:id:int:true', 'name:name:str:true', 'tag:tag:str:false', 'owner:owner:model:false', 'photo-urls:photo_urls:list:false', 'class:class_:str:false'
    ])
    expect(spec.models.find((m) => m.name === 'NewPet')!.fields.map((f) => f.name)).toEqual(['name', 'petName'])
    expect(spec.models.some((m) => m.name === 'Pets')).toBe(false)
  })
  it('reads each endpoint: parameters (shared and referenced), body and response type', () => {
    expect(spec.operations.map((o) => `${o.method} ${o.path} ${o.id}`)).toEqual([
      'GET /pets list_pets', 'POST /pets create_pet', 'GET /pets/{petId} show_pet_by_id', 'DELETE /pets/{petId} delete_pets_by'
    ])
    const list = spec.operations[0]
    expect(list.params).toMatchObject([{ name: 'limit', in: 'query', required: false, type: { kind: 'int' } }])
    expect(list.response).toEqual({ kind: 'list', of: { kind: 'model', name: 'Pet' } })
    expect(spec.operations[1].body).toEqual({ type: { kind: 'model', name: 'NewPet' }, required: true, form: false })
    expect(spec.operations[2].params.map((p) => `${p.in}:${p.py}`)).toEqual(['path:pet_id', 'header:x_trace'])
    expect(spec.operations[3].response).toBeNull()
  })
  it('rejects things that are not OpenAPI', () => {
    expect(() => readSpec({ hello: 1 })).toThrow(/OpenAPI/)
    expect(() => readSpec('x')).toThrow(/OpenAPI/)
  })
  it('a relative server address is resolved against where the description came from', () => {
    expect(readSpec({ ...PETSTORE, servers: [{ url: '/api/v2' }] }, 'https://example.com/docs/openapi.json').baseUrl).toBe('https://example.com/api/v2')
    expect(readSpec({ ...PETSTORE, servers: [{ url: '/api/v2' }] }).warnings.join()).toMatch(/PETSTORE_BASE_URL/)
  })
})

describe('readSpec: Swagger 2', () => {
  const spec = readSpec(SWAGGER)
  it('base address from host, basePath and schemes (https preferred)', () => {
    expect(spec.baseUrl).toBe('https://shop.example.com/api')
  })
  it('basic and query-key auth, body and form parameters', () => {
    expect(spec.auth.map((a) => a.kind)).toEqual(['basic', 'apiKey'])
    expect(spec.operations[0].body).toEqual({ type: { kind: 'model', name: 'Item' }, required: true, form: false })
    expect(spec.operations[0].response).toEqual({ kind: 'model', name: 'Item' })
    expect(spec.operations[1].body?.form).toBe(true)
  })
})

describe('generated client', () => {
  const spec = readSpec(PETSTORE)
  const code = generateClient(spec)
  it('is marked as generated, and edits are noticed', () => {
    expect(code.split('\n')[0]).toMatch(/^# forge:openapi petstore [0-9a-f]{8}$/)
    expect(generatedState(code)).toEqual({ slug: 'petstore', edited: false })
    expect(generatedState(code.replace(/\n/g, '\r\n'))).toEqual({ slug: 'petstore', edited: false })
    expect(generatedState(code.replace('def list_pets', 'def list_all_pets'))).toEqual({ slug: 'petstore', edited: true })
    expect(generatedState('import os\n')).toBeNull()
  })
  it('has a function per endpoint with typed parameters, and only the models it needs', () => {
    expect(code).toContain('def list_pets(limit: Optional[int] = None) -> list[Pet]:')
    expect(code).toContain('def create_pet(body: NewPet) -> Pet:')
    expect(code).toContain('def show_pet_by_id(pet_id: str, x_trace: Optional[str] = None) -> Pet:')
    expect(code).toContain('class Owner:')
    const some = generateClient(spec, new Set(['delete_pets_by']))
    expect(some).not.toContain('class Pet:')
    expect(some).toContain('def delete_pets_by(pet_id: str) -> Any:')
  })
})

describe('imports', () => {
  it('importLine names the module from its path', () => {
    expect(importLine('api/petstore_client.py', ['list_pets', 'Pet'])).toBe('from api.petstore_client import list_pets, Pet')
  })
  it('addImport goes after the existing imports (or the docstring), once', () => {
    const line = 'from api.x import f'
    expect(addImport('import os\nimport sys\n\nprint(1)\n', line)).toBe('import os\nimport sys\nfrom api.x import f\n\nprint(1)\n')
    expect(addImport('"""Doc."""\nx = 1\n', line)).toBe('"""Doc."""\nfrom api.x import f\nx = 1\n')
    expect(addImport('x = 1\n', line)).toBe('from api.x import f\nx = 1\n')
    expect(addImport('import os\r\nx = 1\r\n', line)).toBe('import os\r\nfrom api.x import f\r\nx = 1\r\n')
    const once = addImport('import os\n', line)
    expect(addImport(once, line)).toBe(once)
  })
})

function findPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'pass'], { stdio: 'ignore', timeout: 20000 })
      return cmd
    } catch {
      // try the next
    }
  }
  return null
}
const python = findPython()

describe.skipIf(!python)('the generated client runs (real Python)', () => {
  it('calls the endpoints with auth from the environment and returns models', async () => {
    const seen: { method: string; url: string; auth: string; key: string; body: string; trace: string }[] = []
    const server = createServer((req: IncomingMessage, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ''), key: String(req.headers['x-api-key'] ?? ''), body, trace: String(req.headers['x-trace'] ?? '') })
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'DELETE') return res.writeHead(204).end()
        if (req.url!.startsWith('/v1/pets/')) return res.end(JSON.stringify({ id: 7, name: 'Rex', owner: { name: 'Ann' }, 'photo-urls': ['a'], class: 'dog' }))
        if (req.method === 'POST') return res.end(JSON.stringify({ id: 8, name: 'Tom' }))
        res.end(JSON.stringify([{ id: 1, name: 'A' }, { id: 2, name: 'B', tag: 'x' }]))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const dir = mkdtempSync(join(tmpdir(), 'forge-openapi-'))
    try {
      mkdirSync(join(dir, 'api'))
      writeFileSync(join(dir, 'api', 'petstore_client.py'), generateClient(readSpec(PETSTORE)))
      writeFileSync(join(dir, 'main.py'), [
        'from api.petstore_client import list_pets, create_pet, show_pet_by_id, delete_pets_by, NewPet',
        'pets = list_pets(limit=2)',
        'print([p.name for p in pets], pets[1].tag)',
        'made = create_pet(NewPet(pet_name="Tom", name="Ann"))',
        'print(made.id, made.name)',
        'rex = show_pet_by_id("a b", x_trace="t1")',
        'print(rex.owner.name, rex.photo_urls, rex.class_)',
        'print(delete_pets_by("7"))'
      ].join('\n'))
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(python!, ['main.py'], {
          cwd: dir,
          env: { ...process.env, PETSTORE_BASE_URL: `http://127.0.0.1:${port}/v1`, PETSTORE_TOKEN: 'tok', PETSTORE_API_KEY: 'k1' }
        })
        let text = ''
        let err = ''
        child.stdout.on('data', (d) => (text += d))
        child.stderr.on('data', (d) => (err += d))
        child.on('close', (code) => (code === 0 ? resolve(text.replace(/\r\n/g, '\n')) : reject(new Error(err))))
      })
      expect(out).toBe("['A', 'B'] x\n8 Tom\nAnn ['a'] dog\nNone\n")
      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /v1/pets?limit=2', 'POST /v1/pets', 'GET /v1/pets/a%20b', 'DELETE /v1/pets/7'])
      expect(seen.every((s) => s.auth === 'Bearer tok' && s.key === 'k1')).toBe(true)
      expect(JSON.parse(seen[1].body)).toEqual({ name: 'Ann', petName: 'Tom' })
      expect(seen[2].trace).toBe('t1')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
