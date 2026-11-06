# Forge Connect and the API Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the user asked for no subagents: the final review is a self-review). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Graph in the Connect task a working tool: an API box you fill in (no AI), test once, tick the fields you want, and Forge writes and keeps up to date a readable Python function per request that saves a CSV.

**Architecture:** Pure logic in `src/shared/` (box model, `.env` text, response → fields → rows, code generator, marked-block sync), tested with vitest. The main process adds the test call (Node `fetch`), `.env` reading/writing, `boxes.json` writing, and loads `.env` into Run/Tests/Debug/terminals. The renderer adds a box controller (state + sync, file access injected so it is unit-testable), the Toolbox and Box settings panels, and draws boxes beside their node in the Graph.

**Tech Stack:** Electron + TypeScript 7, hand-written DOM/SVG, vitest (+ happy-dom for views).

**Spec:** `docs/superpowers/specs/2026-11-06-forge-design.md`, Part 3 (plus Constraints).

## Global Constraints

- Hand-written UI, no UI/graph library. Renderer has no Node access; new abilities go through typed IPC in `src/shared/api.ts`.
- The test call is a real network request with the user's secret: only when the user presses **⚡ Test call**, only to the box's URL, only `http:`/`https:`.
- Secrets are never stored in `boxes.json` and never appear in generated code; code reads them with `os.environ` and raises a clear error naming the variable ("add it to .env").
- Generated code uses the standard library only: **`urllib.request`** (builder's call: works on any Python with nothing to install, so no "install requests" step), `json`, `csv`, `os`. `csv.DictWriter`, UTF-8, `newline=""`, header row, nested names joined with dots.
- Markers: `# forge:box <id> (generated, edit in Forge or here)` … `# forge:end <id>`.
- Response cap 5 MB; timeout 20 s.
- Colours only through tokens in `theme.css`; gradients only on the guard's allow-list (this plan adds `.gbox-wire.live`). Plain theme: no sparks, a dot and a highlight.
- No in-app/e2e test runs (user rule). Unit tests, typecheck, build only.
- Commits: `git -c user.name=louisatron84 -c user.email=louisatron84@gmail.com commit`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Files are CRLF: edit with Edit or Python scripts.

## Review Focus

1. A response that is a bare object with no list, an empty list, a list of non-objects (`[1,2,3]`), or mixed item shapes: field list and rows must still be sensible (one record; a single `value` column; merged fields).
2. Names that aren't valid Python (box "My API!", request "2nd list", header `X-Api-Key`): function names, parameters and env var names must be sanitised (`my_api_2nd_list`, `MY_API_TOKEN`).
3. The target file changes underneath: the block hand-edited, deleted, or its markers duplicated/half-deleted: the box must stop writing and say so, never clobber text outside its markers.
4. The target file is open with unsaved edits when the box rewrites it: apply as one undoable step to the open buffer, never write the disk copy over the user's unsaved work.
5. `.env` with comments, `export X=...`, quoted values, `=` inside values, CRLF: parsing and updating one variable must keep every other line exactly.

---

### Task 1: Box model and `.env` text

**Files:**
- Create: `src/shared/boxes.ts`, `src/shared/dotenv.ts`
- Test: `src/shared/boxes.test.ts`, `src/shared/dotenv.test.ts`

**Interfaces:**
- Produces (`boxes.ts`):
  - `type HttpMethod = 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'`
  - `interface KeyValue { key: string; value: string; arg?: boolean }`
  - `type BoxAuth = { kind: 'none' } | { kind: 'header'; name: string; env: string } | { kind: 'query'; name: string; env: string } | { kind: 'bearer'; env: string } | { kind: 'basic'; userEnv: string; passEnv: string }`
  - `interface ApiRequest { id: string; name: string; method: HttpMethod; url: string; query: KeyValue[]; headers: KeyValue[]; body: string; testArgs: Record<string,string>; recordsPath: string[] | null; ticked: string[]; output: string; functionName?: string; test?: TestSummary }`
  - `interface TestSummary { ok: boolean; at: number; status?: number; count?: number; ms?: number; error?: string; fields?: FieldNode[] /* from Task 2 */; sample?: unknown }` (the last response's field tree and up to 20 records are kept so ticks survive a reload; secrets never appear in responses we keep? they can: store `sample` only in memory, not in boxes.json — `normalizeBoxes`/`serializeBoxes` drop `sample`)
  - `interface ApiBox { id: string; type: 'api'; name: string; baseUrl: string; auth: BoxAuth; target: { file: string; mode: 'new'|'append' }; attach: { module: string } | null; requests: ApiRequest[]; hash: string | null; detached: boolean }`
  - `interface BoxesFile { version: 1; boxes: ApiBox[] }`
  - `normalizeBoxes(raw: unknown): ApiBox[]` (drops invalid entries, fills defaults, unique ids), `serializeBoxes(boxes): BoxesFile`
  - `pyName(text: string): string` — lowercase, non `[a-z0-9_]` → `_`, collapse/trim `_`, prefix `_` if it starts with a digit, `'api'` if empty
  - `envName(text: string, suffix: string): string` — `MY_API_TOKEN` style
  - `functionNameFor(box, req): string` — `req.functionName || pyName(box.name + '_' + req.name)`
  - `newApiBox(existingIds: string[], name?: string): ApiBox` — defaults: name `'API'`, auth none, target `{ file: 'api/<pyName(name)>.py', mode: 'new' }`, one GET request named `'data'` with output `'<pyName(box)>_<pyName(req)>.csv'`
  - `newRequest(box): ApiRequest`
- Produces (`dotenv.ts`):
  - `parseDotEnv(text: string): Record<string,string>` — `KEY=value`, `export KEY=value`, `#` comments, blank lines, single/double quotes (double: `\n` escapes), unquoted values trim and drop ` #comment`, `=` inside values kept
  - `setDotEnvVar(text: string, name: string, value: string): string` — replaces the first `name=` line (keeps `export`), else appends; keeps all other lines and the file's EOL (CRLF if the text has any); quotes the value with `"` when it has spaces, `#`, quotes or newlines
  - `mergeEnv(base: Record<string,string|undefined>, dotenv: Record<string,string>): Record<string,string>` — `.env` fills only names `base` doesn't have

- [ ] **Step 1: Write the failing tests** — `boxes.test.ts`: `pyName('My API!')==='my_api'`, `pyName('2nd list')==='_2nd_list'`, `pyName('')==='api'`; `envName('GitHub','TOKEN')==='GITHUB_TOKEN'`; `functionNameFor` → `'github_users'` for box `GitHub` + request `users`; `newApiBox([], 'GitHub')` has target `api/github.py`, output `github_data.csv`; `normalizeBoxes` drops non-objects and unknown types, renames a duplicate id, fixes a bad method to `GET`, keeps `hash`/`detached`; `serializeBoxes` round-trips through `normalizeBoxes` and drops `test.sample`. `dotenv.test.ts`: parse of a file with comment, blank, `export A=1`, `B="x y"`, `C='z'`, `D=a=b`, `E=v # note`, CRLF; `setDotEnvVar` replaces `B` keeping every other line byte-for-byte (incl. CRLF), appends a new var with a trailing newline, quotes `"a b"`; `mergeEnv({A:'1'},{A:'2',B:'3'})` → `{A:'1',B:'3'}`.
- [ ] **Step 2: Run** `npx vitest run src/shared/boxes.test.ts src/shared/dotenv.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `Forge connect: box model and .env text`.

### Task 2: Response → fields → CSV rows

**Files:**
- Create: `src/shared/apiFields.ts`; Test: `src/shared/apiFields.test.ts`

**Interfaces:**
- Produces:
  - `interface RecordList { path: string[]; count: number }`
  - `recordLists(json: unknown): RecordList[]` — every list of objects inside the response (depth ≤ 4), largest first; `[]` path for a top-level list
  - `pickRecords(json: unknown, path: string[] | null): { records: Record<string,unknown>[]; path: string[] | null }` — `path` null → the largest list (or the object itself as one record; a list of non-objects → records `{ value: x }`)
  - `interface FieldNode { path: string[]; name: string; kind: 'value'|'object'|'list'; sample: string; children: FieldNode[] }`
  - `fieldTree(records): FieldNode[]` — merged over all records, first-seen order; objects nest (depth ≤ 4), lists are leaves (`kind 'list'`); sample = first non-null value, shown as text (≤ 60 chars)
  - `fieldKey(path: string[]): string` — `path.join('.')`
  - `defaultTicks(tree): string[]` — top-level `value` and `list` fields
  - `rowsFor(records, ticked: string[]): Record<string,string>[]` — column per ticked key, in tree order given by `ticked`; missing → `''`; lists/objects → `JSON.stringify`; `null` → `''`; booleans `True`/`False`? No: `true`/`false` as JSON text (matches the generated code)
  - `csvPreview(rows, columns, max = 5): string` — RFC 4180 quoting (quote when `,` `"` CR LF), `\r\n` line ends, matching Python's `csv` module default dialect
- The generated Python (Task 3) must produce the same rows: Task 3's test checks one shared fixture through both.

- [ ] **Step 1: Failing tests** — `{"items":[{"a":1},{"a":2,"b":{"c":"x"}}],"meta":{"n":2}}` → `recordLists` `[{path:['items'],count:2}]`; `fieldTree` gives `a` (value) and `b` (object, child `b.c`); `defaultTicks` → `['a']`; `rowsFor(records,['a','b.c'])` → `[{a:'1','b.c':''},{a:'2','b.c':'x'}]`; bare object `{"x":1}` → one record; `[1,2]` → records `[{value:1},{value:2}]`; `[]` → no records, empty tree; a list field `tags:['a','b']` → `'["a", "b"]'` (Python `json.dumps` spacing: `", "` and `": "`); `csvPreview` quotes `a,b` and `say "hi"` and uses `\r\n`.
- [ ] **Step 2: Run** `npx vitest run src/shared/apiFields.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** JSON text for lists/objects uses a `pyJson(value)` helper reproducing `json.dumps` default separators (`, ` and `: `, `ensure_ascii` true) so the preview equals the file Python writes.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Forge connect: response fields and CSV rows`.

### Task 3: Request building and the code generator

**Files:**
- Create: `src/shared/boxCode.ts`; Test: `src/shared/boxCode.test.ts`, `src/main/boxCode.python.test.ts` (runs generated code with the real Python when one is found, else skips)

**Interfaces:**
- Consumes: Task 1 types, `pyName`, `functionNameFor`; Task 2 `pyJson` semantics.
- Produces:
  - `urlArgs(url: string): string[]` — `{name}` placeholders, in order, `pyName`d
  - `buildRequest(box, req, env: Record<string,string|undefined>): { method; url: string; headers: Record<string,string>; body?: string } | { error: string }` — base URL + path (joined with one `/`), placeholders from `req.testArgs`, query rows (URL-encoded), headers, auth from `env` (`{ error: 'GITHUB_TOKEN is not set: add it to .env' }` when missing), JSON body for POST/PUT/PATCH with `Content-Type: application/json`
  - `generateBlock(box, opts: { main: boolean }): string` — the whole marked block, LF line ends (the controller converts to the doc's EOL)
  - Block layout: marker line; `import csv, json, os, urllib.parse, urllib.request` (one per line, sorted); `_<box>_request(method, url, params, headers, body)` helper (adds base URL + auth, reads env with a clear `RuntimeError`, returns parsed JSON); one function per request: `def <fn>(<url args>, <arg query params with defaults>, output_path="<output>"):` with a one-line docstring `"""<METHOD> <url> → <output> (generated by Forge)."""`, picks records (`data["items"]` path, or the list itself, or `[data]`), builds rows with the ticked keys (nested via a small `_<box>_get(record, "b.c")`), writes `csv.DictWriter(f, fieldnames=[...])`, returns rows; when `opts.main`, `if __name__ == "__main__":` calling every function; end marker
  - `blockHash(text: string): string` — FNV-1a 32-bit, hex, over the text with `\r\n` → `\n`
- Builder's call: with `mode: 'append'` the block has no `__main__` (never touch the user's own); `mode: 'new'` files get it inside the block.

- [ ] **Step 1: Failing tests** — `urlArgs('/users/{user name}/repos')` → `['user_name']`; `buildRequest` for bearer with/without the env var; query encoding `q=a b` → `q=a+b`; `generateBlock` for the GitHub box (two requests, bearer auth, ticks `login`,`plan.name`) contains `def github_users(output_path="github_users.csv"):`, `os.environ.get("GITHUB_TOKEN")`, `fieldnames=["login", "plan.name"]`, both markers once, `if __name__ == "__main__":` only with `main: true`, and never the secret value; an `arg` query row `per_page=30` → parameter `per_page="30"`; a URL placeholder → leading parameter. `boxCode.python.test.ts`: write the block to a temp file with a stub `urllib.request.urlopen` (the test prepends a fake that returns the Task 2 fixture), run it with `python -X utf8`, read the CSV, and compare with `csvPreview(rowsFor(...))` of the same fixture; also `python -m py_compile` on blocks for every auth kind.
- [ ] **Step 2: Run** `npx vitest run src/shared/boxCode.test.ts src/main/boxCode.python.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS (the Python test may report skipped if no Python is found; on this machine it should run).
- [ ] **Step 5: Commit** `Forge connect: request building and code generator`.

### Task 4: Marked-block sync

**Files:**
- Create: `src/shared/boxSync.ts`; Test: `src/shared/boxSync.test.ts`

**Interfaces:**
- Consumes: `blockHash`, `generateBlock`.
- Produces:
  - `findBlock(text: string, id: string): { start: number; end: number; text: string } | 'missing' | 'broken'` — offsets of the whole block incl. both marker lines and the final line break; `broken` when a start has no end, an end has no start, or either appears twice
  - `blockState(text: string, box): 'ok' | 'edited' | 'missing' | 'broken'` — `edited` when `box.hash` ≠ `blockHash(found.text)`
  - `replaceBlock(text, id, block): string`, `insertBlock(text, block): string` (append with one blank line between, keeps the file's EOL), `removeBlock(text, id): string` (also drops one surrounding blank line)
  - `withEol(block: string, sampleText: string): string`

- [ ] **Step 1: Failing tests** — find/replace leaves text before and after byte-identical (incl. CRLF file); duplicate start → `broken`; missing end → `broken`; hand edit inside → `edited`; deleted → `missing`; `insertBlock` into `''` and into a file without a trailing newline; `removeBlock` then `insertBlock` round-trips.
- [ ] **Step 2: Run** `npx vitest run src/shared/boxSync.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Forge connect: marked-block sync`.

### Task 5: Main process: test call, `.env`, `boxes.json`, `.env` in processes

**Files:**
- Create: `src/main/apiCall.ts`, `src/main/dotenvFile.ts`; Tests: `src/main/apiCall.test.ts`, `src/main/dotenvFile.test.ts`
- Modify: `src/main/userState.ts` (`PROJECT_FILES` gets `boxes.json`; new `writeProjectFile(root, name, value)`), `src/main/index.ts` (IPC), `src/shared/api.ts` + `src/preload/index.ts`, `src/main/python.ts`, `src/main/tests.ts`, `src/main/debugAdapter.ts`, `src/main/terminals.ts`

**Interfaces:**
- Consumes: Task 1 `parseDotEnv`/`setDotEnvVar`/`mergeEnv`, Task 3 `buildRequest`.
- Produces:
  - `testCall(root: string, box: ApiBox, requestId: string, fetchImpl = fetch): Promise<TestCallResult>`; `interface TestCallResult { ok: boolean; status?: number; statusText?: string; ms: number; json?: unknown; text?: string; tooBig?: boolean; error?: string }` — env = `mergeEnv(process.env, .env)`; refuses non-http(s) URLs; 20 s abort; reads the body up to 5 MB (`tooBig` beyond); JSON when it parses, else `text` (first 2000 chars)
  - `envPath(root)`, `readDotEnv(root): Promise<Record<string,string>>` (missing → `{}`), `setDotEnvValue(root, name, value): Promise<void>` (name must match `^[A-Za-z_][A-Za-z0-9_]*$`), `envNames(root): Promise<string[]>` (names only, for the UI: "set" / "not set"), `gitignoreHasEnv(root): Promise<boolean>`, `addEnvToGitignore(root): Promise<void>`
  - `processEnv(root: string | null, extra?: Record<string,string>): Promise<NodeJS.ProcessEnv>` — `mergeEnv(process.env, .env)` plus `extra`; Run, Tests, Debug adapter and new terminals spawn with it (Run: `spec.root ?? spec.cwd`; Tests: `req.root`; Debug: its `cwd`; terminals: the `cwd` they are created with)
  - IPC + `window.api`: `apiTestCall(root, box, requestId)`, `envNames(root)`, `setEnvValue(root, name, value)`, `envGitignore(root)` → `{ ignored: boolean }`, `addEnvToGitignore(root)`, `writeProjectFile(root, name, value)`; `RunSpec.root?: string`

- [ ] **Step 1: Failing tests** — `apiCall.test.ts` with a local `node:http` server: JSON 200 → `{ok:true,status:200,json}`; bearer header arrives from a temp project's `.env`; 404 → `ok:false,status:404` with the body; non-JSON → `text`; body over the cap (cap lowered via a test-only parameter) → `tooBig`; `file:///` URL → error without a request; missing env var → error naming it. `dotenvFile.test.ts` in a temp dir: set/read/names, invalid name rejected, `.gitignore` detection (`.env`, `/.env`, `*.env`) and adding keeps existing lines; `processEnv` gives process values priority.
- [ ] **Step 2: Run** `npx vitest run src/main/apiCall.test.ts src/main/dotenvFile.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, then wire IPC, preload, `api.ts`, the four spawns, `PROJECT_FILES`, `writeProjectFile`.
- [ ] **Step 4: Run** those tests, then `npm run typecheck` — Expected: PASS, no errors.
- [ ] **Step 5: Commit** `Forge connect: test call, .env, boxes.json; .env loaded into runs`.

### Task 6: Box controller

**Files:**
- Create: `src/renderer/boxes/controller.ts`; Test: `src/renderer/boxes/controller.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `interface BoxFiles { read(rel: string): Promise<string | null>; write(rel: string, text: string): Promise<void> /* open doc: one undoable edit + save; else disk */; saveBoxes(file: BoxesFile): Promise<void>; note(message: string): void }`
  - `class BoxController` with `boxes: readonly ApiBox[]`, `selected: string | null`, `onChange(fn)`, `load(raw: unknown)`, `add(attach: { module: string } | null, target?: { file: string; mode: 'new'|'append' }): ApiBox`, `select(id)`, `update(id, fn: (box) => void): Promise<void>` (commit: save + rewrite code if written and state `ok`), `state(id): Promise<'unwritten'|'ok'|'edited'|'missing'|'broken'|'detached'>`, `preview(id): string` (the block as it would be written), `writeCode(id): Promise<void>` (first time; creates the file for `new` mode), `overwrite(id)`, `keepEdits(id)` (sets `detached`), `reattach(id)`, `remove(id, removeCode: boolean)`, `setTest(id, requestId, result: TestCallResult)` (fills `test`, field tree, default ticks on first success, records path)
  - Status note after an automatic rewrite: `Updated api/github.py from the GitHub box`.
- [ ] **Step 1: Failing tests** with an in-memory `BoxFiles`: `writeCode` creates `api/github.py` with the block and stores its hash; `update` (rename a request) rewrites only the block and notes; after a hand edit `update` leaves the file alone and `state` → `edited`; `keepEdits` → `detached`, no further writes; `overwrite` writes; deleted block → `missing`; `remove(id,true)` removes the block and the box; `setTest` with the Task 2 fixture ticks `a` and keeps user ticks on a later test; every change calls `saveBoxes` with no `sample`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/boxes/controller.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Forge connect: box controller`.

### Task 7: Boxes on the Graph and the Toolbox

**Files:**
- Create: `src/renderer/graph/boxLayer.ts` (pure placement + SVG), `src/renderer/boxes/toolbox.ts`; Tests: `src/renderer/graph/boxLayer.test.ts`, `src/renderer/boxes/toolbox.test.ts`
- Modify: `src/renderer/graph/graphView.ts` (hooks `boxes()`, `selectBox(id)`, `dropBox(nodeId | null)`; draws the box layer after nodes; accepts drops of `application/x-forge-box`), `src/main/theme.test.ts` (allow-list `.gbox-wire.live`), `src/renderer/styles.css`

**Interfaces:**
- Produces:
  - `boxAnchor(box, mode: 'modules'|'calls', nodeIds: Set<string>): string | null` — Modules: `attach.module`; Calls: `<module>:<first request's function>` if present, else the module node, else null
  - `placeBoxes(layout: Layout, boxes, mode, nodeIds): Map<string, { x; y; width; height; anchor: string | null }>` — right of the anchor (gap 24), stacked downward per anchor with gap 8; unanchored boxes stacked in a column right of the whole layout
  - `boxSummary(box, req): string` — `GET api.github.com/users → github_users.csv · 2 of 5 fields` (`not tested` when no field tree)
  - Box SVG: `g.gbox` (hot outline, title, one line + status dot per request: `.dot.untested|ok|fail`), wire `path.gbox-wire` (dashed) to the anchor; `.gbox-wire.live` while a test call runs: Molten = heat gradient stroke + a spark (`circle.spark` with `<animateMotion>`), Plain = a dot only
  - `class Toolbox { body: HTMLElement; constructor(hooks: { add(): void }) }` — API (draggable, click adds), Database / File / Schedule disabled with "coming later"
- [ ] **Step 1: Failing tests** — `boxAnchor` in both modes; `placeBoxes` stacks two boxes on one module without overlap and puts an unanchored box right of `layout.width`; `boxSummary` with and without a test; Toolbox: API button calls `add`, the three others are `disabled` and say "coming later", API is `draggable` with `application/x-forge-box` data.
- [ ] **Step 2: Run** `npx vitest run src/renderer/graph/boxLayer.test.ts src/renderer/boxes/toolbox.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, wire into GraphView, styles, guard allow-list.
- [ ] **Step 4: Run** those + `src/main/theme.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `Forge connect: boxes on the graph, toolbox`.

### Task 8: Box settings panel

**Files:**
- Create: `src/renderer/boxes/boxSettings.ts`; Test: `src/renderer/boxes/boxSettings.test.ts`

**Interfaces:**
- Consumes: `BoxController`, `window.api` calls via injected hooks.
- Produces: `class BoxSettings { body: HTMLElement; constructor(ctrl: BoxController, hooks: BoxSettingsHooks); render(): void }`, `interface BoxSettingsHooks { testCall(box, requestId): Promise<TestCallResult>; envNames(): Promise<string[]>; setSecret(name: string, value: string): Promise<void>; envIgnored(): Promise<boolean>; ignoreEnv(): Promise<void>; confirmCode(title: string, code: string): Promise<boolean> /* preview dialog */; showDiff(current: string, next: string): Promise<boolean>; confirm(message: string): boolean; liveWire(boxId: string, on: boolean): void }`
- Layout: empty state ("Select a box on the Graph, or add one from the Toolbox"); box section (name, base URL, auth kind + its fields, secret input "Save to .env" with set/not-set badge and the `.gitignore` offer, target file + new/append); request tabs + `+ Add request`; per request: name, method, URL, query rows (key, value, "argument" tick), header rows, body (POST/PUT/PATCH only), placeholder test values, **⚡ Test call** + result line (`✓ 200 OK · 50 items · 0.4 s`), "Records from" select, foldable field tree with tick boxes and samples, CSV preview table, output path, function name; footer: state banner (`code edited by hand` with Overwrite with box / Keep my edits; `code missing` with Write again / Remove box; `detached` with Re-attach), **Write code** (first time, via `confirmCode`), Remove box (asks whether to remove the code too).
- Commits happen on `change` (Enter / leaving a field / ticking), not on `input`.
- [ ] **Step 1: Failing tests** (happy-dom, a real controller with in-memory files and fake hooks): empty state text; changing the request name input and firing `change` calls through to the file block; `input` alone doesn't; Test call shows `✓ 200 OK · 2 items` and the field tree with `a` ticked; unticking writes `fieldnames` without it; the body field is hidden for GET; edited state shows both buttons and Keep my edits detaches; secret input never ends up in `saveBoxes` output.
- [ ] **Step 2: Run** `npx vitest run src/renderer/boxes/boxSettings.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** + styles.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `Forge connect: Box settings panel`.

### Task 9: Wire it into Forge; docs; v0.44

**Files:**
- Modify: `src/shared/layouts.ts` (`PANEL_IDS` + `'toolbox'`, `'box'`), `src/renderer/dock/model.ts` (Connect default: row `[files, outline] 0.18 · graph 0.56 · column[toolbox 0.28, box 0.72] 0.26`, terminal drawer below as now), `src/renderer/dock/model.test.ts`, `src/renderer/main.ts` (controller with real `BoxFiles`: open doc → `applyEditsToDoc` + save, else `readTextFile`/`writeTextFile`; load `boxes.json` on folder open; register panels; Graph hooks; selecting a box reveals `box`; status notes; rescans after writes), `README.md`, `docs/CHECKLIST.md`, `package.json` version `0.44.0` if versions are kept there (else as the repo does)
- [ ] **Step 1: Failing test** — `model.test.ts`: Connect default places `graph`, `toolbox`, `box`; `normalizeLayouts` keeps the new ids.
- [ ] **Step 2: Run** `npx vitest run src/renderer/dock/model.test.ts src/shared/layouts.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the wiring and docs (README "Connect and the API box" section; CHECKLIST: Part 3 line done, 5.3 items "Generate `.env` keys", "Support APIs without specifications" sub-items, "Preview generated code", "Ensure … readable Python", "offer to remove associated code" ticked with `(v0.44)`).
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build` — Expected: all pass, clean.
- [ ] **Step 5: Commit** `v0.44: Connect and the API box (Part 3 of the Forge design)`.
