/**
 * The Tests tab in the bottom panel: every test in the project, grouped by
 * file, with its last result. Run all, only the failed ones, a file or a
 * single test (▶ on each row, or "Run Test at Cursor"). Clicking a test opens
 * it; clicking a failure opens the line where it failed.
 * Uses pytest when installed (unittest TestCase tests run under it too),
 * otherwise unittest.
 */
import type { TestFile, TestResult, DiscoveredTest } from '../shared/tests'
import { failureLine, matchJUnit, parseJUnit, parseUnittest, pytestId, unittestId, unittestModules } from '../shared/tests'
import { lastLines } from '../shared/outputBuffer'

/** Lines of raw output kept in the Log view. */
const MAX_LOG_LINES = 5000

export interface TestHooks {
  root(): string | null
  /** The interpreter to test with (full path), or null if there isn't one (the hook says so). */
  python(): Promise<string | null>
  open(path: string, line: number): void
  /** Save changed files first; false if one couldn't be saved. */
  saveAll(): Promise<boolean>
  installPytest(): void
  /** Called after a run or discovery: e.g. update the panel tab title. */
  changed(failed: number, total: number): void
}

const ICON: Record<TestResult['status'] | 'running', string> = {
  passed: '✓', failed: '✗', error: '!', skipped: '○', notrun: '·', running: '⟳'
}

export class TestView {
  readonly body: HTMLDivElement
  readonly actions: HTMLDivElement
  private readonly summaryEl: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly logEl: HTMLPreElement
  private files: TestFile[] = []
  /** Last result per test, keyed by pytestId. */
  private results = new Map<string, TestResult>()
  /** Tests in the run that's going on (pytestIds), or null. */
  private running: Set<string> | null = null
  private summary = ''
  private framework: 'pytest' | 'unittest' | null = null
  private readonly expanded = new Set<string>()
  private stopButton!: HTMLButtonElement
  private discovered = false
  /** The raw output shown in Log, and output not drawn yet. */
  private logText = ''
  private logPending = ''
  private logFrame = 0

  private drawLog(): void {
    this.logFrame = 0
    this.logText = lastLines(this.logText + this.logPending, MAX_LOG_LINES).text
    this.logPending = ''
    this.logEl.textContent = this.logText
    if (!this.logEl.hidden) this.logEl.scrollTop = this.logEl.scrollHeight
  }

  private setLog(text: string): void {
    this.logPending = ''
    if (this.logFrame) cancelAnimationFrame(this.logFrame)
    this.logFrame = 0
    this.logText = text
    this.logEl.textContent = text
  }

  constructor(private readonly hooks: TestHooks) {
    this.body = document.createElement('div')
    this.body.className = 'tests-view'
    this.summaryEl = document.createElement('div')
    this.summaryEl.className = 'tests-summary'
    this.listEl = document.createElement('div')
    this.listEl.className = 'tests-list'
    this.logEl = document.createElement('pre')
    this.logEl.className = 'tests-log'
    this.logEl.hidden = true
    this.body.append(this.summaryEl, this.listEl, this.logEl)

    this.actions = document.createElement('div')
    this.actions.className = 'panel-buttons'
    const button = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('click', fn)
      this.actions.append(b)
      return b
    }
    button('▶ All', 'Run all tests', () => void this.run('all'))
    button('▶ Failed', 'Run the tests that failed last time', () => void this.run('failed'))
    button('⟳', 'Find tests again', () => void this.discover())
    this.stopButton = button('■', 'Stop the test run', () => void window.api.stopTests())
    this.stopButton.disabled = true
    button('Log', 'Show or hide the raw test output', () => {
      this.logEl.hidden = !this.logEl.hidden
      this.listEl.hidden = !this.logEl.hidden
      if (!this.logEl.hidden) this.logEl.scrollTop = this.logEl.scrollHeight
    })

    // Collect output and draw it once per frame, keeping only the last lines.
    window.api.onTestOutput((text) => {
      this.logPending += text
      if (this.logPending.length > 4_000_000) this.logPending = this.logPending.slice(-2_000_000)
      if (!this.logFrame) this.logFrame = requestAnimationFrame(() => this.drawLog())
    })
    this.render()
  }

  get isRunning(): boolean {
    return this.running !== null
  }

  /** Called when the tab is shown: find tests the first time. */
  show(): void {
    if (!this.discovered) void this.discover()
  }

  /** Forget everything (another folder was opened). */
  reset(): void {
    this.files = []
    this.results.clear()
    this.summary = ''
    this.discovered = false
    this.setLog('')
    this.render()
  }

  /** Read the test files again (after opening a folder or saving a test file). */
  async discover(): Promise<void> {
    const root = this.hooks.root()
    if (!root) return this.reset()
    try {
      this.files = await window.api.discoverTests(root)
    } catch (err) {
      this.summary = `Couldn't look for tests: ${String(err)}`
    }
    if (this.hooks.root() !== root) return
    this.discovered = true
    // Drop results of tests that no longer exist.
    const ids = new Set(this.allIds())
    for (const id of [...this.results.keys()]) if (!ids.has(id)) this.results.delete(id)
    this.render()
  }

  private allIds(): string[] {
    return this.files.flatMap((f) => f.tests.map((t) => pytestId(f.rel, t)))
  }

  /** Run the test whose `def` contains this line of `path` (or the whole file if none). */
  async runAt(path: string, line: number): Promise<void> {
    await this.discover()
    const file = this.fileFor(path)
    if (!file) return this.say('This file has no tests (test files are named test_*.py or *_test.py).')
    const test = [...file.tests].filter((t) => t.line <= line).sort((a, b) => b.line - a.line)[0]
    return this.run(test ? [pytestId(file.rel, test)] : file.tests.map((t) => pytestId(file.rel, t)))
  }

  async runFile(path: string): Promise<void> {
    await this.discover()
    const file = this.fileFor(path)
    if (!file) return this.say('This file has no tests (test files are named test_*.py or *_test.py).')
    return this.run(file.tests.map((t) => pytestId(file.rel, t)))
  }

  private fileFor(path: string): TestFile | undefined {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    return this.files.find((f) => norm(f.path) === norm(path))
  }

  private say(text: string): void {
    this.summary = text
    this.render()
  }

  /** Run all tests, the failed ones, or these (pytestIds). */
  async run(which: 'all' | 'failed' | string[]): Promise<void> {
    const root = this.hooks.root()
    if (!root) return this.say('Open a folder first.')
    if (this.running) return
    if (!(await this.hooks.saveAll())) return this.say('Test run cancelled: a file could not be saved.')
    await this.discover()
    let ids: string[]
    if (which === 'all') ids = this.allIds()
    else if (which === 'failed') {
      ids = this.allIds().filter((id) => ['failed', 'error'].includes(this.results.get(id)?.status ?? ''))
      if (!ids.length) return this.say('No failed tests to run again.')
    } else ids = which
    if (!this.files.length) return this.say('No tests found. Test files are named test_*.py or *_test.py, with functions named test_*.')

    const python = await this.hooks.python()
    if (!python) return this.say('No Python interpreter found: pick one with 🐍 in the status bar.')
    const pytest = await window.api.hasPytest(python).catch(() => false)
    const selected = this.testsFor(ids)
    if (!pytest && selected.some(({ test }) => !test.unittest)) {
      this.summary = ''
      this.render()
      this.renderPytestMissing()
      return
    }
    this.framework = pytest ? 'pytest' : 'unittest'
    const all = which === 'all'
    const runIds = pytest
      ? (all ? [] : this.shorten(ids))
      : (all ? unittestModules(this.files) : selected.map(({ file, test }) => unittestId(file.rel, test)))

    this.running = new Set(ids)
    this.stopButton.disabled = false
    this.setLog(`$ ${pytest ? 'python -m pytest' : 'python -m unittest -v'} ${runIds.join(' ')}   (in ${root})\n`)
    this.summary = `Running ${ids.length} test${ids.length === 1 ? '' : 's'} with ${this.framework}…`
    this.render()
    let res
    try {
      res = await window.api.runTests({ python, root, framework: this.framework, ids: runIds })
    } catch (err) {
      res = { exitCode: null, output: '', seconds: 0, error: String(err) }
    } finally {
      this.running = null
      this.stopButton.disabled = true
    }
    if (this.hooks.root() !== root) return

    // Read the results.
    let got = new Map<string, TestResult>()
    if (this.framework === 'pytest' && res.xml) got = matchJUnit(this.files, parseJUnit(res.xml))
    else if (this.framework === 'unittest') {
      const byUnittestId = parseUnittest(res.output)
      for (const f of this.files) for (const t of f.tests) {
        const r = byUnittestId.get(unittestId(f.rel, t))
        if (r) got.set(pytestId(f.rel, t), r)
      }
    }
    for (const id of ids) this.results.set(id, got.get(id) ?? { status: 'notrun', message: '', details: '', seconds: 0 })
    for (const [id, r] of got) this.results.set(id, r) // e.g. tests in files we didn't discover the same way

    const counts = { passed: 0, failed: 0, error: 0, skipped: 0, notrun: 0 }
    for (const id of ids) counts[this.results.get(id)!.status]++
    const parts = [
      counts.passed && `${counts.passed} passed`,
      counts.failed && `${counts.failed} failed`,
      counts.error && `${counts.error} errors`,
      counts.skipped && `${counts.skipped} skipped`,
      counts.notrun && `${counts.notrun} not run`
    ].filter(Boolean)
    if (res.error) this.summary = `${res.error}. See Log.`
    else if (!got.size) {
      const tail = res.output.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200)
      this.summary = `No results came back${res.exitCode === null ? ' (stopped)' : ''}. ${tail} (see Log)`
    } else this.summary = `${parts.join(', ')} in ${res.seconds.toFixed(1)}s (${this.framework})`
    // Open the details of the first failure.
    const firstFail = ids.find((id) => ['failed', 'error'].includes(this.results.get(id)!.status))
    if (firstFail) this.expanded.add(firstFail)
    this.render()
  }

  /** A whole file selected → its path instead of every test in it (shorter command line). */
  private shorten(ids: string[]): string[] {
    const set = new Set(ids)
    const out: string[] = []
    for (const f of this.files) {
      const fileIds = f.tests.map((t) => pytestId(f.rel, t))
      if (fileIds.every((id) => set.has(id))) {
        out.push(f.rel)
        for (const id of fileIds) set.delete(id)
      }
    }
    return [...out, ...set]
  }

  private testsFor(ids: string[]): { file: TestFile; test: DiscoveredTest }[] {
    const set = new Set(ids)
    return this.files.flatMap((file) => file.tests.filter((t) => set.has(pytestId(file.rel, t))).map((test) => ({ file, test })))
  }

  private renderPytestMissing(): void {
    const box = document.createElement('div')
    box.className = 'tests-empty'
    box.textContent = "These tests need pytest, which isn't installed in this interpreter. "
    const install = document.createElement('button')
    install.className = 'tests-inline-button'
    install.textContent = 'Install pytest'
    install.addEventListener('click', () => this.hooks.installPytest())
    box.append(install)
    this.listEl.replaceChildren(box)
  }

  private render(): void {
    const total = this.allIds().length
    let failed = 0
    for (const id of this.allIds()) if (['failed', 'error'].includes(this.results.get(id)?.status ?? '')) failed++
    this.hooks.changed(failed, total)
    this.summaryEl.textContent = this.summary || (total ? `${total} test${total === 1 ? '' : 's'} found. ▶ All to run them.` : '')
    if (!this.hooks.root()) {
      this.listEl.replaceChildren(this.empty('Open a folder to see its tests.'))
      return
    }
    if (!this.files.length) {
      this.listEl.replaceChildren(this.empty(this.discovered ? 'No tests found. Test files are named test_*.py or *_test.py, with functions named test_*.' : 'Looking for tests…'))
      return
    }
    this.listEl.replaceChildren(...this.files.map((f) => this.renderFile(f)))
  }

  private empty(text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'tests-empty'
    el.textContent = text
    return el
  }

  private statusOf(id: string): TestResult['status'] | 'running' {
    if (this.running?.has(id)) return 'running'
    return this.results.get(id)?.status ?? 'notrun'
  }

  private renderFile(f: TestFile): HTMLElement {
    const group = document.createElement('div')
    group.className = 'tests-file'
    const ids = f.tests.map((t) => pytestId(f.rel, t))
    const header = document.createElement('div')
    header.className = 'tests-file-header'
    const statuses = ids.map((id) => this.statusOf(id))
    const fileStatus = statuses.includes('running') ? 'running'
      : statuses.some((s) => s === 'failed' || s === 'error') ? 'failed'
      : statuses.every((s) => s === 'passed' || s === 'skipped') && statuses.includes('passed') ? 'passed' : 'notrun'
    header.append(this.icon(fileStatus))
    const name = document.createElement('span')
    name.className = 'tests-file-name'
    name.textContent = f.rel
    const count = document.createElement('span')
    count.className = 'search-file-count'
    count.textContent = String(f.tests.length)
    header.append(name, count, this.runButton(`Run the tests in ${f.rel}`, () => void this.run(ids)))
    header.addEventListener('click', () => this.hooks.open(f.path, f.tests[0]?.line ?? 0))
    group.append(header)
    for (const t of f.tests) group.append(...this.renderTest(f, t))
    return group
  }

  private renderTest(f: TestFile, t: DiscoveredTest): HTMLElement[] {
    const id = pytestId(f.rel, t)
    const status = this.statusOf(id)
    const result = this.results.get(id)
    const row = document.createElement('div')
    row.className = `tests-row st-${status}`
    row.title = `${id}\nClick to open`
    const label = document.createElement('span')
    label.className = 'tests-name'
    label.textContent = t.className ? `${t.className} › ${t.name}` : t.name
    row.append(this.icon(status), label)
    if (result && result.seconds >= 0.01) {
      const time = document.createElement('span')
      time.className = 'tests-time'
      time.textContent = `${result.seconds < 1 ? Math.round(result.seconds * 1000) + 'ms' : result.seconds.toFixed(1) + 's'}`
      row.append(time)
    }
    row.append(this.runButton(`Run ${t.name}`, () => void this.run([id])))
    row.addEventListener('click', () => this.hooks.open(f.path, t.line))
    const out: HTMLElement[] = [row]
    if (result && (result.status === 'failed' || result.status === 'error' || (result.status === 'skipped' && result.message))) {
      const msg = document.createElement('div')
      msg.className = `tests-message st-${result.status}`
      const failAt = failureLine(result.details, f.rel)
      const toggle = document.createElement('span')
      toggle.className = 'tests-toggle'
      const open = this.expanded.has(id)
      toggle.textContent = result.details ? (open ? '▾' : '▸') : ''
      toggle.title = 'Show or hide the details'
      toggle.addEventListener('click', (e) => {
        e.stopPropagation()
        if (this.expanded.has(id)) this.expanded.delete(id)
        else this.expanded.add(id)
        this.render()
      })
      const text = document.createElement('span')
      text.textContent = result.message || (result.status === 'error' ? 'error' : 'failed') + (failAt !== null ? ` at line ${failAt + 1}` : '')
      msg.title = failAt !== null ? `Click to go to line ${failAt + 1}` : ''
      msg.append(toggle, text)
      msg.addEventListener('click', () => this.hooks.open(f.path, failAt ?? t.line))
      out.push(msg)
      if (open && result.details) {
        const pre = document.createElement('pre')
        pre.className = 'tests-details'
        pre.textContent = result.details
        out.push(pre)
      }
    }
    return out
  }

  private icon(status: TestResult['status'] | 'running'): HTMLElement {
    const el = document.createElement('span')
    el.className = `tests-icon st-${status}`
    el.textContent = ICON[status]
    el.setAttribute('aria-label', status)
    return el
  }

  private runButton(title: string, fn: () => void): HTMLElement {
    const b = document.createElement('button')
    b.className = 'tests-run'
    b.textContent = '▶'
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }
}
