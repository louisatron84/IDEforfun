/**
 * The Toolbox panel: the kinds of box you can put on the Graph. Click to
 * add one, or drag it onto a module to put its code in that file. Only the
 * API box exists so far; the others are shown as coming later.
 */

/** Drag data type for a box dragged from the Toolbox onto the Graph. */
export const BOX_DRAG_TYPE = 'application/x-forge-box'

const TYPES = [
  { type: 'api', label: 'API', note: 'Call a web API and save what it returns to a CSV file', enabled: true },
  { type: 'openapi', label: 'OpenAPI client', note: 'Write a Python client from an API\'s OpenAPI description', enabled: true },
  { type: 'database', label: 'Database', note: 'coming later', enabled: false },
  { type: 'file', label: 'File', note: 'coming later', enabled: false },
  { type: 'schedule', label: 'Schedule', note: 'coming later', enabled: false }
] as const

export class Toolbox {
  readonly body: HTMLDivElement

  constructor(hooks: { add(): void; addOpenApi?(): void }) {
    this.body = document.createElement('div')
    this.body.className = 'toolbox'
    const hint = document.createElement('div')
    hint.className = 'toolbox-hint'
    hint.textContent = 'Drag a box onto a module on the Graph, or click to add one in a new file.'
    this.body.append(hint)
    for (const t of TYPES) {
      const b = document.createElement('button')
      b.className = 'toolbox-item'
      b.dataset.type = t.type
      b.disabled = !t.enabled
      const name = document.createElement('span')
      name.className = 'toolbox-name'
      name.textContent = t.label
      const note = document.createElement('span')
      note.className = 'toolbox-note'
      note.textContent = t.note
      b.append(name, note)
      b.title = t.enabled ? `${t.label} box: ${t.note}` : `${t.label} box: ${t.note}`
      if (t.type === 'openapi') {
        b.addEventListener('click', () => hooks.addOpenApi?.())
        b.hidden = !hooks.addOpenApi
      } else if (t.enabled) {
        b.draggable = true
        b.addEventListener('click', () => hooks.add())
        b.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData(BOX_DRAG_TYPE, t.type)
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
        })
      }
      this.body.append(b)
    }
  }
}
