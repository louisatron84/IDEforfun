# Forge Look (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the IDE its Forge identity on the current layout: the name Forge, the Molten (default) and Plain themes, Smithy schematic shapes, bundled fonts, and project files in `.forge/`.

**Architecture:** All colours move into one token file (`src/renderer/theme.css`) with a Molten block and a Plain block; `styles.css` only uses `var(--…)`. Guard tests read the CSS files and enforce the identity rules: contrast, no gradients on clickable things, square corners, no stray colour literals. Settings migrate `dark`/`light` to `molten`/`plain`. The main process prepares `<project>/.forge/` (renaming or copying a legacy `.ideforfun/`) when a folder opens.

**Tech Stack:** Electron 44, TypeScript 7, electron-vite/Vite 7, vitest 4, hand-written CSS; fonts from `@fontsource/space-grotesk` and `@fontsource/jetbrains-mono` (OFL).

**Spec:** `docs/superpowers/specs/2026-11-06-forge-design.md` (Part 1 only; Parts 2 and 3 get their own plans).

## Global Constraints

- User-visible name is **Forge** everywhere (window title "file — folder — Forge", About, Welcome, menus, messages). Do **not** change `package.json` `name` or add `productName`: Electron's userData folder is derived from them, and changing it would lose users' settings, keybindings and recent projects.
- Molten tokens (spec table): bg `#120c0a`, panel `#170e0b`, raised `#1d120e`, line `#3a2017`, line-strong `#5a3322`, fg `#f3e2d4`, heat-1 `#ffcf5c`, heat-2 `#ffb02e`, heat-3 `#ff6a1a`, heat-4 `#e8431d`. **fg-muted is `#a08576`** (the spec's `#8f7568` measures 4.45:1 on panel, below AA).
- Molten syntax: keyword `#ff6a3d`, function `#ffc857`, string `#e8a87c`, **comment `#a0806f`** (the spec's `#7a5f52` measures 3.25:1), decorator `#d9a35f`, number `#f0a36b`, constant `#ff8f5a`, builtin `#e0b48a`, self `#d98a6a`, class `#ffd27a`, call `#f5c98a`, property (JSON keys) `#ffc857`.
- Every text colour (fg, fg-muted, all `--tok-*`) must be **≥ 4.5:1** against `--bg` and `--bg-panel` in both themes. Button text on `--heat-3` must also be ≥ 4.5:1 (use `#1a0904`).
- Gradients only on the Forge wordmark and the graph canvas's blueprint grid (Part 3 adds live connection lines). **Never on buttons or anything clickable.**
- Square corners: every `border-radius` is `var(--radius)` (`0`) or `50%` (round dots only).
- Plain theme: black/white high contrast; no heat colours, glow, grid or gradients; same layout and shapes. Status colours (errors, diff, git) may stay, muted.
- Fonts: UI **Space Grotesk**, code **JetBrains Mono**, bundled (no network). The code font size and line height stay user settings.
- Respect reduced motion: no transitions/animations under `prefers-reduced-motion: reduce`.
- Sparks are not part of this plan: nothing is "live" yet; they arrive with live connections in Part 3.
- Project folder `.forge/`; legacy `.ideforfun/` is renamed on first open (copied if the rename fails). Internal names stay as they are (env vars `IDEFORFUN_*`, `localStorage` keys `ideforfun.*`).
- No in-app/e2e test runs (the user's standing rule). Unit tests, typecheck and build only.

## Review Focus

1. **Settings files written by older versions** (`"theme": "dark"` / `"light"`, or junk) must load as Molten / Plain, never crash or reset other settings. Test in Task 1.
2. **A project with both `.ideforfun/` and `.forge/`** (e.g. opened by an old build after migrating) must use `.forge/` and leave the old folder alone. Test in Task 2.
3. **A `.ideforfun/` that can't be renamed** (a file in it is locked on Windows) must still give a working `.forge/` (copy) and report it, not fail the folder open. Test in Task 2 (simulated rename failure).
4. **The Plain theme must define every token Molten defines**, or parts of the UI render with missing colours. Test in Task 4.
5. **Graph and diff colours on the new dark brown background** (history lanes, diff add/del, git badges) must stay distinguishable and readable. Covered by the no-literal guard plus the contrast test in Task 4 (status tokens included in the contrast list).

---

### Task 1: Theme setting becomes Molten / Plain

**Files:**
- Modify: `src/shared/settings.ts` (type, default, normalizer)
- Modify: `src/renderer/settingsView.ts:123-124` (Theme row)
- Modify: `src/renderer/main.ts` (`view.toggleTheme` command near line 1921)
- Test: `src/shared/settings.test.ts` (exists: add cases)

**Interfaces:**
- Produces: `export type ThemeName = 'molten' | 'plain'`; `Settings.theme: ThemeName`; `DEFAULT_SETTINGS.theme === 'molten'`. `document.documentElement.dataset.theme` is set to the theme name (unchanged code path in `applySettings`).

- [ ] **Step 1: Write the failing tests** in `src/shared/settings.test.ts`

```ts
it('theme: molten by default; old dark/light settings map to molten/plain', () => {
  expect(DEFAULT_SETTINGS.theme).toBe('molten')
  expect(normalizeSettings({ theme: 'dark' }).theme).toBe('molten')
  expect(normalizeSettings({ theme: 'light' }).theme).toBe('plain')
  expect(normalizeSettings({ theme: 'plain' }).theme).toBe('plain')
  expect(normalizeSettings({ theme: 'neon', fontSize: 16 })).toMatchObject({ theme: 'molten', fontSize: 16 })
})
```

- [ ] **Step 2: Run** `npx vitest run src/shared/settings.test.ts`. Expected: FAIL (default is `'dark'`).
- [ ] **Step 3: Implement** `ThemeName`, the default, and the mapping in `normalizeSettings` (`'dark'` → `'molten'`, `'light'` → `'plain'`, anything else invalid → default). Settings dialog Theme row: segmented `[['molten', 'Molten'], ['plain', 'Plain']]`, description "Molten: Forge's colours. Plain: black and white, high contrast". Command `view.toggleTheme` becomes title "Toggle Plain Theme" and flips molten ↔ plain. Fix every other compile error from the type change (`npm run typecheck`).
- [ ] **Step 4: Run** `npx vitest run src/shared/settings.test.ts` and `npm run typecheck`. Expected: PASS, no errors.
- [ ] **Step 5: Commit** `git commit -m "Forge: theme setting is molten/plain (dark/light migrate)"`

### Task 2: Project folder `.forge/` with migration from `.ideforfun/`

**Files:**
- Modify: `src/shared/settings.ts` (constants)
- Create: `src/main/projectDir.ts`
- Test: `src/main/projectDir.test.ts`
- Modify: `src/main/userState.ts` (use `PROJECT_DIR`), `src/main/index.ts` (IPC), `src/preload/index.ts`, `src/shared/api.ts`, `src/renderer/main.ts` (call on folder open, update every user-visible `.ideforfun` string), `src/renderer/settingsView.ts:54`, `src/renderer/pythonEnv.ts:6`, `src/shared/runConfig.ts:2`, `src/main/projectScan.py` (`SKIP_DIRS` gains `'.forge'`, keeps `'.ideforfun'`)

**Interfaces:**
- Produces: in `src/shared/settings.ts`: `PROJECT_DIR = '.forge'`, `LEGACY_PROJECT_DIR = '.ideforfun'` (`PROJECT_SETTINGS_DIR` is removed; all users switch to `PROJECT_DIR`).
- Produces: `prepareProjectDir(root: string, fsOps?: { rename?: (a: string, b: string) => Promise<void> }): Promise<'none' | 'migrated' | 'copied' | 'both'>` in `src/main/projectDir.ts`. `fsOps.rename` defaults to `fs.promises.rename` (injectable to simulate a locked folder).
- Produces: IPC `project:prepare` → `window.api.prepareProjectDir(root: string): Promise<'none' | 'migrated' | 'copied' | 'both'>`.

- [ ] **Step 1: Write the failing tests** in `src/main/projectDir.test.ts` (real temp folders via `mkdtempSync`)

```ts
it('renames a legacy .ideforfun folder to .forge', async () => {
  // root/.ideforfun/settings.json exists, no .forge
  expect(await prepareProjectDir(root)).toBe('migrated')
  expect(existsSync(join(root, '.forge', 'settings.json'))).toBe(true)
  expect(existsSync(join(root, '.ideforfun'))).toBe(false)
})
it('nothing to do when there is no legacy folder', async () => {
  expect(await prepareProjectDir(root)).toBe('none')
  expect(existsSync(join(root, '.forge'))).toBe(false) // not created eagerly
})
it('uses .forge and leaves .ideforfun alone when both exist', async () => {
  expect(await prepareProjectDir(root)).toBe('both')
  expect(readFileSync(join(root, '.forge', 'settings.json'), 'utf8')).toBe('{"tabSize":2}')
  expect(existsSync(join(root, '.ideforfun', 'settings.json'))).toBe(true)
})
it('copies when the rename fails (locked folder) and keeps the original', async () => {
  const res = await prepareProjectDir(root, { rename: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }) } })
  expect(res).toBe('copied')
  expect(existsSync(join(root, '.forge', 'run.json'))).toBe(true)
  expect(existsSync(join(root, '.ideforfun', 'run.json'))).toBe(true)
})
```

- [ ] **Step 2: Run** `npx vitest run src/main/projectDir.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `prepareProjectDir` (copy fallback with `fs.promises.cp(src, dst, { recursive: true })`), switch `userState.ts` to `PROJECT_DIR`, add the IPC/preload/api entry, and in the renderer's open-folder flow call `prepareProjectDir(folder)` **before** `loadProjectSettings`; for `'migrated'` show the status note "Moved project settings from .ideforfun/ to .forge/", for `'copied'` "Copied project settings to .forge/ (the old .ideforfun/ folder couldn't be moved)". Replace every user-visible `.ideforfun` string in the files listed above with `.forge`.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck`. Expected: all PASS (update any existing test that asserts a `.ideforfun` path to `.forge`).
- [ ] **Step 5: Commit** `git commit -m "Forge: project files live in .forge/ (migrates .ideforfun/)"`

### Task 3: The name Forge

**Files:**
- Modify: `src/main/index.ts:51` (BrowserWindow title), `src/main/menu.ts:229-235` (About), `src/renderer/index.html` (`<title>`), `src/renderer/main.ts` (window title near line 1327, crash-recovery message near line 1547), `src/renderer/welcome.ts:80`, `src/main/terminals.ts:91` (`TERM_PROGRAM: 'Forge'`), `src/renderer/debug/session.ts:158,180` (`name`/`clientName: 'Forge'`; keep `clientID: 'ideforfun'`), `src/renderer/lsp/server.ts:143` (`clientInfo: { name: 'Forge' }`), `README.md` (title and first paragraph)
- Test: `src/renderer/naming.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test** `src/renderer/naming.test.ts`: reads (with `node:fs`) `src/renderer/index.html`, `src/renderer/welcome.ts`, `src/main/menu.ts`, `src/renderer/main.ts` and asserts none contains the literal `'IDEforfun'` inside a string the user sees; implement as: `expect(text).not.toMatch(/['"`][^'"`\n]*IDEforfun[^'"`\n]*['"`]/)` per file, and `expect(html).toContain('<title>Forge</title>')`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/naming.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the renames listed under Files. Window title format stays `[● name, folder, 'Forge'].join(' — ')`.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge: the IDE is called Forge"`

### Task 4: Molten and Plain colour tokens, with guard tests

**Files:**
- Create: `src/renderer/theme.css` (the only place colour values live)
- Modify: `src/renderer/index.html` (link `theme.css` before `styles.css`)
- Modify: `src/renderer/styles.css` (remove the `:root` token block at lines 1-14 and the light-theme block near lines 504-533; replace every colour literal with a token)
- Test: `src/renderer/theme.test.ts`

**Interfaces:**
- Produces (CSS custom properties, defined in both `:root` (Molten) and `:root[data-theme="plain"]`): existing names keep working (`--bg`, `--bg-panel`, `--bg-hover`, `--bg-active`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--selection`, `--selection-unfocused`, `--match`, all `--tok-*`, `--minimap-view`) plus new: `--raised`, `--line-strong`, `--heat-1`…`--heat-4`, `--on-heat` (text on heat-3), `--radius`, `--grid`, `--err`, `--warn`, `--ok`, `--info`, `--tok-property`, and one token per remaining meaning found in `styles.css` (diff add/del backgrounds, git status letters, conflict shades, history lane colours as `--lane-1`…`--lane-8`). Mapping: `--bg-panel` = panel, `--border` = line, `--accent` = heat-2.
- Produces: `historyView.ts` reads lane colours from `--lane-1`…`--lane-8` (via `getComputedStyle`) instead of its `COLORS` array.

- [ ] **Step 1: Write the failing tests** `src/renderer/theme.test.ts` (read the CSS with `node:fs`; a small helper parses `name: value;` pairs out of the `:root {…}` and `:root[data-theme="plain"] {…}` blocks of `theme.css`, and a WCAG `contrast(a, b)` helper for hex colours)

```ts
it('Plain defines every token Molten defines', () => {
  expect(Object.keys(plain).sort()).toEqual(Object.keys(molten).sort())
})
it.each(['molten', 'plain'])('%s: all text colours pass WCAG AA on bg and panel', (name) => {
  const t = name === 'molten' ? molten : plain
  const text = ['--fg', '--fg-muted', '--err', '--warn', '--ok', '--info', ...Object.keys(t).filter((k) => k.startsWith('--tok-'))]
  for (const k of text) for (const bg of ['--bg', '--bg-panel']) expect(contrast(t[k], t[bg]), `${k} on ${bg}`).toBeGreaterThanOrEqual(4.5)
  expect(contrast(t['--on-heat'], t['--heat-3'])).toBeGreaterThanOrEqual(4.5)
})
it('Molten uses the spec values', () => {
  expect(molten).toMatchObject({ '--bg': '#120c0a', '--bg-panel': '#170e0b', '--raised': '#1d120e', '--border': '#3a2017', '--line-strong': '#5a3322',
    '--fg': '#f3e2d4', '--fg-muted': '#a08576', '--heat-1': '#ffcf5c', '--heat-2': '#ffb02e', '--heat-3': '#ff6a1a', '--heat-4': '#e8431d',
    '--tok-keyword': '#ff6a3d', '--tok-function': '#ffc857', '--tok-string': '#e8a87c', '--tok-comment': '#a0806f', '--tok-decorator': '#d9a35f', '--radius': '0' })
})
it('styles.css has no colour literals (all colours come from theme.css)', () => {
  expect(styles.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([])
})
```

- [ ] **Step 2: Run** `npx vitest run src/renderer/theme.test.ts`. Expected: FAIL (`theme.css` missing).
- [ ] **Step 3: Implement** `theme.css` with the Global Constraints values. Plain: `--bg #000000`, `--bg-panel #000000`, `--raised #0d0d0d`, `--border #8a8a8a`, `--line-strong #ffffff`, `--fg #ffffff`, `--fg-muted #c8c8c8`, `--accent #ffffff`, all `--heat-*` `#ffffff`, `--on-heat #000000`, `--grid transparent`, syntax greys/whites (comment `#9a9a9a` italic in styles), status colours muted (each passing the contrast test). Move every literal out of `styles.css` (including `rgba(...)` shadows and overlays → tokens like `--shadow`, `--overlay`). Keep `color-scheme: dark` for both themes.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` and `npm run build`. Expected: PASS, build succeeds.
- [ ] **Step 5: Commit** `git commit -m "Forge: Molten and Plain colour tokens in theme.css"`

### Task 5: Bundled fonts

**Files:**
- Modify: `package.json` (dependencies), `src/renderer/main.ts` (imports at the top), `src/renderer/theme.css` (`--font-ui`, `--font-code`)
- Test: extend `src/renderer/theme.test.ts`

**Interfaces:**
- Produces: `--font-ui: 'Space Grotesk', system-ui, sans-serif` and `--font-code: 'JetBrains Mono', Consolas, monospace` in both theme blocks.

- [ ] **Step 1: Write the failing test** in `theme.test.ts`: `expect(molten['--font-ui']).toMatch(/^'Space Grotesk'/)`, `expect(molten['--font-code']).toMatch(/^'JetBrains Mono'/)`, and `package.json` dependencies contain exact (no `^`/`~`) versions of `@fontsource/space-grotesk` and `@fontsource/jetbrains-mono`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/theme.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**: `npm install --save-exact @fontsource/space-grotesk@<v> @fontsource/jetbrains-mono@<v>` with versions from `npm view <pkg> time` at least two weeks old. Import weights 400/500/600/700 (Space Grotesk) and 400/700 (JetBrains Mono) as side-effect CSS imports at the top of `src/renderer/main.ts`. Set the font tokens.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build`; then check `out/renderer/assets` contains `.woff2` files (`ls out/renderer/assets | grep woff2`). Expected: PASS, font files present.
- [ ] **Step 5: Commit** `git commit -m "Forge: bundle Space Grotesk and JetBrains Mono"`

### Task 6: Smithy schematic shapes and the wordmark

**Files:**
- Modify: `src/renderer/styles.css`, `src/renderer/index.html` (wordmark as the first child of `#toolbar`: `<span class="wordmark">Forge</span>`), `src/renderer/graph/graphView.ts` (only if a class hook is missing)
- Test: extend `src/renderer/theme.test.ts`

**Interfaces:** CSS only. Uses the Task 4 tokens.

- [ ] **Step 1: Write the failing tests** in `theme.test.ts` (a helper splits `styles.css` into `{ selector, body }` rules):

```ts
it('square corners: every border-radius is var(--radius) or 50%', () => {
  for (const r of rules) for (const v of r.body.matchAll(/border-radius:\s*([^;]+)/g)) expect(['var(--radius)', '50%'], r.selector).toContain(v[1].trim())
})
it('gradients only on the wordmark and the graph grid, never on clickable things', () => {
  const withGradient = rules.filter((r) => /gradient\(/.test(r.body)).map((r) => r.selector)
  for (const s of withGradient) expect(s).toMatch(/^(\.wordmark|\.graph-canvas)$/)
})
it('reduced motion turns off transitions and animations', () => {
  expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important[\s\S]*animation: none !important/)
})
it('primary buttons are solid, angled and use the heat colour', () => {
  const btn = rules.find((r) => r.selector.split(',').map((s) => s.trim()).includes('#toolbar button'))!
  expect(btn.body).toMatch(/background: var\(--heat-3\)/)
  expect(btn.body).toMatch(/clip-path: polygon\(6px 0/)
})
```

- [ ] **Step 2: Run** `npx vitest run src/renderer/theme.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `styles.css`:
  - every `border-radius` → `var(--radius)` (round dots and status circles → `50%`);
  - **angled solid buttons**: primary (toolbar, dialog confirm, Welcome primary) `background: var(--heat-3); color: var(--on-heat); clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%)`; secondary: `var(--raised)` background with `var(--heat-2)` text, same clip; no gradients;
  - **active tab / sidebar tab / panel tab**: `box-shadow: inset 0 -2px 0 var(--heat-2)` plus `outline: 1px solid var(--heat-2)` on the active editor tab; no fill change beyond `--bg`;
  - **corner marks**: shared `::before` (7×7px, 2px `var(--heat-3)` top and left borders, absolutely positioned top-left) on `#sidebar`, the bottom panel, `.settings-dialog`, the palette dialog, `.graph-side`, `.welcome-page` sections (give each `position: relative` if needed);
  - **section labels** (`.debug-heading`, `.graph-side-head`, Welcome section titles, settings group titles): 10px, uppercase, `letter-spacing: 0.12em`, `color: var(--fg-muted)`;
  - **blueprint grid** on `.graph-canvas` using `--grid` (18px, two `linear-gradient` layers);
  - **graph nodes**: square, selected node `stroke: var(--heat-2)` plus `filter: drop-shadow(3px 3px 0 var(--ember-shadow))` (add `--ember-shadow` to both theme blocks: Molten `#ff6a1a59`, Plain `transparent`); graph colours use tokens (`--heat-2` for focus/out, `--heat-4` for cycles);
  - **wordmark** `.wordmark`: Space Grotesk 700, 15px, heat gradient text (`background: linear-gradient(90deg, var(--heat-1), var(--heat-3), var(--heat-4)); -webkit-background-clip: text; color: transparent`); in Plain the tokens are white, so it reads as plain white;
  - **reduced motion** media query as in the test.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge: Smithy schematic shapes and the wordmark"`

### Task 7: Roadmap and version

**Files:**
- Modify: `docs/CHECKLIST.md` (Tier 4: mark "Consistent visual language for graphs, code, debugging and terminal" as done for Part 1 with a note "(v0.42: Forge look: Molten / Plain themes, Smithy schematic shapes, bundled fonts)"; add a line under Tier 4 for Part 2 and Part 3 pointing to the spec), `README.md` (theme and name mention if not done in Task 3)

- [ ] **Step 1: Run the full check**: `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: all pass.
- [ ] **Step 2: Update** the checklist lines above.
- [ ] **Step 3: Commit** `git commit -m "v0.42: Forge look (Part 1 of the Forge design)"`
