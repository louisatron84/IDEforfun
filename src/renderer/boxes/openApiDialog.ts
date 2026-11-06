/**
 * "Add API from OpenAPI…": load a description (address or file), see what's
 * in it, tick the endpoints to generate, pick where the client goes and
 * whether to import it into the open file, preview the code, then generate.
 */
import { readSpec, envKeys, type ApiSpec } from '../../shared/openapi'
import { generateClient } from '../../shared/openapiCode'

export interface OpenApiChoice {
  spec: ApiSpec
  chosen: Set<string>
  /** Relative to the project, with / separators. */
  file: string
  /** Import the chosen functions into this file (relative path), or null. */
  importInto: string | null
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function showOpenApiDialog(opts: {
  load(source: string): Promise<{ doc?: unknown; from: string; error?: string }>
  pick(): Promise<string | null>
  /** The Python file open in the editor (relative), to offer importing into. */
  currentFile: string | null
  preview(title: string, code: string): Promise<boolean>
}): Promise<OpenApiChoice | null> {
  return new Promise((resolve) => {
    const overlay = el('div', 'code-dialog-overlay')
    const dlg = el('div', 'code-dialog openapi-dialog')
    dlg.tabIndex = -1
    dlg.setAttribute('role', 'dialog')
    dlg.setAttribute('aria-label', 'Add API from OpenAPI')
    const done = (answer: OpenApiChoice | null) => {
      overlay.remove()
      resolve(answer)
    }

    const title = el('div', 'code-dialog-title', 'Add API from an OpenAPI description')
    const intro = el('p', 'openapi-intro', 'Paste the address of an OpenAPI (or Swagger) description, often called openapi.json or swagger.yaml, or choose the file. Forge writes a Python client for the endpoints you pick: a function each, with classes for the data.')
    const sourceRow = el('div', 'openapi-source')
    const source = el('input', 'openapi-input')
    source.placeholder = 'https://api.example.com/openapi.json'
    source.setAttribute('aria-label', 'Address or file of the OpenAPI description')
    const choose = el('button', '', 'Choose file…')
    const loadButton = el('button', 'primary', 'Load')
    sourceRow.append(source, choose, loadButton)
    const status = el('div', 'openapi-status')
    status.setAttribute('aria-live', 'polite')
    const content = el('div', 'openapi-content')
    const buttons = el('div', 'code-dialog-buttons')
    const cancel = el('button', '', 'Cancel')
    cancel.addEventListener('click', () => done(null))
    const previewButton = el('button', '', 'Preview code')
    const generate = el('button', 'primary', 'Generate')
    previewButton.disabled = generate.disabled = true
    buttons.append(cancel, previewButton, generate)
    dlg.append(title, intro, sourceRow, status, content, buttons)

    let spec: ApiSpec | null = null
    const ticks = new Map<string, HTMLInputElement>()
    const fileInput = el('input', 'openapi-input')
    fileInput.setAttribute('aria-label', 'File for the client')
    const importBox = el('input')
    importBox.type = 'checkbox'
    importBox.checked = !!opts.currentFile

    const chosen = () => new Set([...ticks].filter(([, b]) => b.checked).map(([id]) => id))
    const choice = (): OpenApiChoice | null => {
      if (!spec) return null
      const file = fileInput.value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
      if (!/\.py$/.test(file) || file.split('/').some((p) => p === '..' || !p)) {
        status.textContent = 'The client file must be a .py path inside the project, like api/shop_client.py.'
        return null
      }
      if (!chosen().size) {
        status.textContent = 'Tick at least one endpoint.'
        return null
      }
      return { spec, chosen: chosen(), file, importInto: opts.currentFile && importBox.checked ? opts.currentFile : null }
    }
    const refreshButtons = () => {
      previewButton.disabled = generate.disabled = !spec || !chosen().size
    }

    const show = (s: ApiSpec) => {
      spec = s
      ticks.clear()
      const facts = el('dl', 'openapi-facts')
      const fact = (k: string, v: string) => facts.append(el('dt', '', k), el('dd', '', v))
      fact('API', `${s.title}${s.version ? ` ${s.version}` : ''}`)
      if (s.description) fact('About', s.description)
      fact('Address', s.baseUrl || '(none: set it in .env)')
      fact('Sign-in', s.auth.length ? s.auth.map((a) => (a.kind === 'apiKey' ? `API key (${a.env})` : a.kind === 'bearer' ? `token (${a.env})` : `user name and password (${a.userEnv}, ${a.passEnv})`)).join(', ') : 'none')
      fact('Settings', `${envKeys(s).join(', ')}: added to .env (empty) for you to fill in`)
      const warn = s.warnings.map((w) => el('div', 'openapi-warning', w))
      const fileRow = el('label', 'openapi-row')
      fileInput.value = `api/${s.slug}_client.py`
      fileRow.append(el('span', '', 'Client file'), fileInput)
      const importRow = el('label', 'openapi-row')
      if (opts.currentFile) importRow.append(importBox, document.createTextNode(` Import the picked functions into ${opts.currentFile}`))
      const all = el('div', 'openapi-ops')
      const head = el('div', 'openapi-ops-head')
      const allButton = el('button', '', 'All')
      const noneButton = el('button', '', 'None')
      allButton.addEventListener('click', () => {
        for (const b of ticks.values()) b.checked = true
        refreshButtons()
      })
      noneButton.addEventListener('click', () => {
        for (const b of ticks.values()) b.checked = false
        refreshButtons()
      })
      head.append(el('span', '', `${s.operations.length} endpoint${s.operations.length === 1 ? '' : 's'}`), allButton, noneButton)
      const byTag = new Map<string, typeof s.operations>()
      for (const o of s.operations) {
        let list = byTag.get(o.tag)
        if (!list) byTag.set(o.tag, (list = []))
        list.push(o)
      }
      const list = el('div', 'openapi-op-list')
      for (const [tag, ops] of byTag) {
        if (byTag.size > 1) list.append(el('div', 'openapi-tag', tag))
        for (const o of ops) {
          const row = el('label', 'openapi-op')
          const box = el('input')
          box.type = 'checkbox'
          box.checked = s.operations.length <= 40
          box.addEventListener('change', refreshButtons)
          ticks.set(o.id, box)
          row.append(box, el('span', 'openapi-method', o.method), el('span', 'openapi-path', o.path), el('span', 'openapi-fn', `${o.id}()`), el('span', 'openapi-summary', o.summary))
          row.title = o.summary ? `${o.method} ${o.path}: ${o.summary}` : `${o.method} ${o.path}`
          list.append(row)
        }
      }
      all.append(head, list)
      content.replaceChildren(facts, ...warn, fileRow, ...(opts.currentFile ? [importRow] : []), all)
      if (s.operations.length > 40) status.textContent = 'Many endpoints: tick the ones you need (or All).'
      refreshButtons()
    }

    const load = async () => {
      const value = source.value.trim()
      if (!value) {
        status.textContent = 'Paste an address, or choose a file.'
        return
      }
      status.textContent = 'Loading…'
      loadButton.disabled = true
      try {
        const res = await opts.load(value)
        if (res.error || res.doc === undefined) {
          status.textContent = res.error ?? 'Nothing was loaded.'
          return
        }
        try {
          show(readSpec(res.doc, res.from))
          status.textContent = ''
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : String(err)
        }
      } finally {
        loadButton.disabled = false
      }
    }
    loadButton.addEventListener('click', () => void load())
    source.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void load()
    })
    choose.addEventListener('click', async () => {
      const file = await opts.pick()
      if (!file) return
      source.value = file
      void load()
    })
    previewButton.addEventListener('click', () => {
      const c = choice()
      if (c) void opts.preview(`${c.file} (preview)`, generateClient(c.spec, c.chosen))
    })
    generate.addEventListener('click', () => {
      const c = choice()
      if (c) done(c)
    })
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        done(null)
      }
    })
    overlay.append(dlg)
    document.body.append(overlay)
    source.focus()
  })
}
