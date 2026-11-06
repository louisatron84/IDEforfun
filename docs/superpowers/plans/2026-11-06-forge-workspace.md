# Forge Task Workspace (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed sidebar + editor + bottom panel with a dock of movable panels arranged per task (Code · Connect · Debug · Run), switched from the top bar, rearranged in an Edit Layout mode, plus two new panels: Where you are and In this file.

**Architecture:** A pure dock model (`src/renderer/dock/model.ts`: a tree of splits whose leaves are tab stacks of panel ids) does every layout operation and is unit-tested. `DockView` renders a tree into the DOM by **moving** the existing panel elements (never re-creating them) and toggling their `hidden` flag, so existing code that checks `el.hidden` keeps working. `TaskController` owns one arrangement per task, switching, revealing panels, persistence and resets. A small facade keeps today's `panel.show(id)` / `showSidebar(view)` call sites working.

**Tech Stack:** TypeScript 7, hand-written DOM (no UI or docking library), vitest 4 with `happy-dom` (new dev dependency, for DOM tests only), Electron IPC for saving layouts.

**Spec:** `docs/superpowers/specs/2026-11-06-forge-design.md` (Part 2, plus the Graph-panel calls from the review section of Part 3).

## Global Constraints

- Tasks: `code`, `connect`, `debug`, `run`, shown as **Code · Connect · Debug · Run**; shortcuts **Ctrl+Alt+1…4** (builder's call in the spec; chosen here).
- Top bar: `[Forge wordmark] [Code] [Connect] [Debug] [Run] … [project · branch] [▶ Run]`. ▶ Run becomes **■ Stop** while a program runs. Open Folder, Debug, Stop and the settings gear leave the top bar (they remain in the menu, palette, Welcome page and shortcuts).
- Panel ids (fixed): `files`, `search`, `outline`, `git`, `history`, `editor`, `where`, `infile`, `graph`, `terminal`, `problems`, `output`, `debug`, `tests`, `references`, `calls`.
- The `editor` panel can't be closed and is always placed in the Code task. Other tasks may leave it out.
- Default arrangements (fractions are the starting sizes):
  - **code**: row [ stack(files, search, outline, git) .20 · column [ stack(editor) .70 · stack(terminal, problems, output, tests, references, calls, history) .30 ] .58 · column [ stack(where) .60 · stack(infile) .40 ] .22 ]
  - **connect**: column [ row [ stack(files, outline) .20 · stack(graph) .80 ] .78 · stack(terminal, problems, output) .22 ]
  - **debug**: column [ row [ stack(editor) .62 · stack(debug) .38 ] .75 · stack(terminal, output, problems) .25 ]
  - **run**: column [ row [ stack(editor) .60 · stack(output, tests, problems) .40 ] .72 · stack(terminal) .28 ]
- Panels keep their state when moved or hidden (scroll, selection, terminal sessions): elements are moved between containers, never rebuilt.
- Arrangements are saved **per user** in userData (`layouts.json`). The active task is saved **per project** (in the existing workspace state).
- Starting a debug session switches to Debug, and ending it switches back to the previous task. Setting `switchToDebugTask` (default `true`) turns this off. Running doesn't switch task.
- Edit Layout mode only (View → Edit Layout): moving and closing panels. Outside it, dividers can still be dragged to resize. Esc or Done leaves the mode.
- Opening code from Connect (double-click a graph node, "Open") switches to the Code task and opens the file there. Where you are, double-click: switches to Connect and reveals that module. The Project Graph is a panel (`graph`) in Connect; its overlay mode is removed.
- Minimum size: no split child below **8%** of its split.
- Molten/Plain tokens, square corners and the guard tests from Part 1 apply to every new CSS rule (`src/main/theme.test.ts` must stay green).
- No in-app/e2e test runs (the user's standing rule). Unit tests (including happy-dom DOM tests), typecheck and build.

## Review Focus

1. **A saved `layouts.json` from another version** (unknown panel ids, a missing editor in Code, duplicated panels, bad sizes, junk) must load as a valid arrangement, never a blank window. Test in Task 2 (`normalizeLayouts`).
2. **Code revealing a panel the current task doesn't place** (e.g. a run shows Output while in Connect, Ctrl+Shift+M in Debug) must make it appear, not do nothing. Test in Task 4 (`reveal`).
3. **Dragging the last panel out of a stack, or dropping a panel onto its own stack's centre**: no empty stacks or one-child splits left behind; dropping on yourself is a no-op. Test in Task 1.
4. **Switching tasks and moving panels must not re-create the editor or terminals**: the same DOM element is reused, and onShow (which refits xterm) runs when a panel becomes visible. Test in Task 3.
5. **Extreme resizing** (divider dragged past the edge, tiny window): sizes are clamped to the 8% minimum and still sum to 1. Test in Task 1.

---

### Task 1: Dock model (pure)

**Files:**
- Create: `src/renderer/dock/model.ts`
- Test: `src/renderer/dock/model.test.ts`

**Interfaces:**
- Produces:
  - `type TaskId = 'code' | 'connect' | 'debug' | 'run'`; `TASKS: readonly TaskId[]`
  - `type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'`
  - `interface StackNode { kind: 'stack'; id: string; panels: string[]; active: string; collapsed?: boolean }`
  - `interface SplitNode { kind: 'split'; id: string; dir: 'row' | 'column'; children: DockNode[]; sizes: number[] }`. Sizes are fractions summing to 1.
  - `type DockNode = StackNode | SplitNode`
  - `PANEL_IDS: readonly string[]` (the Global Constraints list); `EDITOR = 'editor'`
  - `defaultArrangement(task: TaskId): DockNode`
  - `placedPanels(root: DockNode): string[]`; `findStack(root: DockNode, panel: string): StackNode | null`
  - `removePanel(root: DockNode, panel: string): DockNode | null`. Collapses empty stacks and one-child splits; null if nothing is left.
  - `insertPanel(root: DockNode, panel: string, targetStackId: string, zone: Zone): DockNode`
  - `movePanel(root: DockNode, panel: string, targetStackId: string, zone: Zone): DockNode`
  - `activate(root: DockNode, panel: string): DockNode`; `setCollapsed(root: DockNode, stackId: string, collapsed: boolean): DockNode`
  - `resize(root: DockNode, splitId: string, sizes: number[]): DockNode`
  - `zoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone`. Centre when inside the middle 40% box, else the nearest edge.
  - All functions are pure: they return new trees and never mutate their input. New node ids come from `nextId(root)` ("n" + a counter above the highest existing number).

- [ ] **Step 1: Write the failing tests** in `model.test.ts`. One `it` per behaviour:
  - Every default arrangement places only known panels, each at most once; `code` places `editor`; `connect` places `graph` and not `editor`.
  - `insertPanel(…, zone 'center')` adds to the target stack and activates it. `'left'`/`'right'` wrap the target in a `row` split with the new stack first or second, sizes `[0.5, 0.5]`. `'top'`/`'bottom'` do the same with `column`.
  - Inserting next to a stack whose parent split already has the same direction adds a sibling instead of nesting: siblings split the target's share in half.
  - `removePanel` of the last panel in a stack removes the stack. A split left with one child is replaced by that child, with sizes renormalised.
  - `movePanel(root, p, ownStackId, 'center')` returns a tree deep-equal to `root`. Moving a stack's only panel to its own edge is also a no-op.
  - `resize` clamps every size to ≥ 0.08 and renormalises to sum 1 (e.g. `[0.99, 0.01]` → `[0.92, 0.08]`). An unknown split id returns the root unchanged.
  - `zoneAt({0,0,100,100}, 50, 50)` → `'center'`; `(5, 50)` → `'left'`; `(50, 97)` → `'bottom'`.
  - The input is unchanged after every operation (deep-freeze the input in the test).
- [ ] **Step 2: Run** `npx vitest run src/renderer/dock/model.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `model.ts` with the interface above.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: dock layout model"`

### Task 2: Saving layouts, the active task and the debug-switch setting

**Files:**
- Create: `src/shared/layouts.ts`, `src/shared/layouts.test.ts`
- Modify: `src/main/userState.ts` (`layouts.json` read/write, next to keybindings), `src/main/index.ts` (IPC `layouts:get`, `layouts:save`), `src/preload/index.ts`, `src/shared/api.ts`, `src/shared/projectState.ts` (+ its test: `task` field), `src/shared/settings.ts` (+ test: `switchToDebugTask`)
- Move: the `DockNode`/`TaskId` types and `PANEL_IDS`/`TASKS` constants from Task 1 into `src/shared/layouts.ts` and re-export them from `dock/model.ts` (main must read the types without importing renderer code).

**Interfaces:**
- Produces: `type SavedLayouts = Partial<Record<TaskId, DockNode>>`; `normalizeLayouts(raw: unknown): SavedLayouts`. Invalid tasks are dropped. Within a tree, unknown panel ids are dropped, duplicates keep their first occurrence, sizes are fixed (≥ 0.08, sum 1), empty stacks and one-child splits collapse, `active` falls back to the first panel. A `code` tree without `editor` is dropped, so that task uses its default. Anything unusable for a task is dropped too.
- Produces: `window.api.getLayouts(): Promise<SavedLayouts>`, `window.api.saveLayouts(layouts: SavedLayouts): Promise<void>`.
- Produces: `WorkspaceState.task: TaskId` (default `'code'`); `Settings.switchToDebugTask: boolean` (default `true`, shown in Settings as "Switch to the Debug task while debugging").

- [ ] **Step 1: Write the failing tests:** `layouts.test.ts` covers Review Focus 1 (unknown panel, duplicate panel, missing editor in code, sizes `[2, -1]`, a `null` tree, a non-object) plus a round trip of every `defaultArrangement` unchanged. Also: `projectState.test.ts` gets `task` defaulting to `'code'` and keeping `'debug'`; `settings.test.ts` gets `switchToDebugTask` defaulting to true and keeping false.
- [ ] **Step 2: Run** `npx vitest run src/shared`. Expected: FAIL.
- [ ] **Step 3: Implement** the normaliser, the userState read/write (same pattern as keybindings: synchronous-safe write, bad file → `{}`), the IPC, the workspace and settings fields, and the Settings dialog row.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: save layouts per user, task per project"`

### Task 3: DockView (rendering a tree)

**Files:**
- Modify: `package.json` (devDependency `happy-dom`, exact version at least two weeks old)
- Create: `src/renderer/dock/dockView.ts`, `src/renderer/dock/dockView.test.ts` (first line `// @vitest-environment happy-dom`)
- Modify: `src/renderer/styles.css` (dock styles, tokens only)

**Interfaces:**
- Consumes: Task 1 model.
- Produces:
  - `interface PanelDef { id: string; title: string; body: HTMLElement; actions?: HTMLElement; onShow?: () => void; closable?: boolean }` (`closable` is false for `editor`)
  - `class DockView`:
    - `constructor(container: HTMLElement, hooks: { changed(root: DockNode): void; closePanel(id: string): void; drop(panel: string, targetStackId: string, zone: Zone): void })`
    - `register(def: PanelDef): void`
    - `setTitle(id: string, title: string): void`
    - `render(root: DockNode): void`
    - `isShown(id: string): boolean`
    - `editing: boolean` (getter/setter)
- Rendering rules:
  - A split is a flex container with one draggable divider between children. Dragging calls `resize` live, then `hooks.changed` on release.
  - A stack is a tab strip (title + actions of the active panel, + ✕ on closable tabs in edit mode only) and a body area.
  - A collapsed stack shows only its tab strip.
  - Unplaced bodies go into one hidden "store" element inside `container`. Inactive bodies get `hidden = true`; the active one gets `hidden = false`, and its `onShow` runs whenever it becomes visible.

- [ ] **Step 1: Write the failing tests** (happy-dom):
  - Rendering `defaultArrangement('code')` puts the `editor` body element inside the container. After `render(defaultArrangement('connect'))` and back, the **same element object** is in the DOM again (identity check), and its `onShow` ran again.
  - Inactive panels in a stack have `hidden === true` and the active one `false`.
  - An unplaced panel's body is in the store with `hidden === true`, and `isShown` is false.
  - `setTitle('problems', 'Problems (3)')` updates the tab text.
  - In edit mode a closable tab has a close button that calls `hooks.closePanel`. The editor tab has none.
  - A pointer drag on a divider (dispatch pointerdown/pointermove/pointerup with clientX) calls `hooks.changed` once, on release, with sizes that still sum to 1.
- [ ] **Step 2: Run** `npx vitest run src/renderer/dock`. Expected: FAIL.
- [ ] **Step 3: Implement** `DockView` and its CSS: square corners, ember corner mark on stacks, hot underline on the active tab, `--grid` background in edit mode.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`. Expected: PASS (theme guard tests included).
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: DockView renders and resizes the dock"`

### Task 4: TaskController (switching, revealing, resetting, saving)

**Files:**
- Create: `src/renderer/dock/tasks.ts`, `src/renderer/dock/tasks.test.ts` (happy-dom)

**Interfaces:**
- Consumes: `DockView` (Task 3), model (Task 1), `SavedLayouts` (Task 2).
- Produces: `class TaskController`
  - `constructor(view: DockView, opts: { saved: SavedLayouts; save(l: SavedLayouts): void; taskChanged(t: TaskId): void })`
  - `readonly current: TaskId`
  - `switchTo(task: TaskId): void`. Renders that task's arrangement and calls `taskChanged`.
  - `reveal(panel: string): void`
  - `hide(panel: string): void`
  - `toggleDrawer(): void`
  - `isShown(panel: string): boolean`
  - `resetCurrent(): void`
  - `closePanel(id: string): void`
  - `addPanel(id: string): void`
  - `hiddenPanels(): string[]`
  - `beginDebug(enabled: boolean): void` and `endDebug(): void`
- **`reveal` rules:**
  - A placed panel is activated, and its stack is un-collapsed.
  - Not placed, `editor` → switch to `code`. Not placed, `graph` → switch to `connect`.
  - Not placed, a side panel (`files`, `search`, `outline`, `git`, `where`, `infile`) → added to the stack holding `files`, else to a new left stack.
  - Anything else → added to the stack holding `terminal`, else to a new bottom stack (`.30`).
  - Revealing changes the arrangement and saves it, debounced 500 ms.
- **`toggleDrawer`** (Ctrl+J): collapses or expands the stack holding `terminal`. If none is placed, it reveals `terminal`.
- **`hide(panel)`**: collapses the panel's stack when it is that drawer, else it's a no-op. Used where today's code calls `panel.hide()`.
- **`beginDebug` / `endDebug`:** `beginDebug(true)` remembers the current task and switches to `debug`. `endDebug` returns to the remembered task, unless the user switched task in between. `beginDebug(false)` does nothing.

- [ ] **Step 1: Write the failing tests** for each rule above, including Review Focus 2:
  - in `connect`, `reveal('problems')` makes `problems` shown, in the drawer stack;
  - in `debug`, `reveal('editor')` when placed only activates it;
  - in `connect`, `reveal('editor')` switches to `code`.
  
  Also: saved layouts are used over defaults, `resetCurrent` restores the default and saves, and `closePanel('editor')` is ignored.
- [ ] **Step 2: Run** `npx vitest run src/renderer/dock/tasks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `TaskController`.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: tasks, reveal rules, debug switch"`

### Task 5: Move the UI into the dock, and the new top bar

**Files:**
- Modify: `src/renderer/index.html`:
  - New top bar: `#task-switcher` with 4 buttons (`data-task`), `#project-label` (keeps id `folder-name` on the folder part), `#run-button`.
  - `#dock` replaces `#workspace`.
  - A hidden `#panel-store` holds the existing `#file-tree`, `#search-panel`, `#outline-panel`, `#git-panel` and `#editor-pane`.
  - The `#sidebar` and `#sidebar-tabs` markup is removed.
- Modify: `src/renderer/main.ts`:
  - Register every panel with the DockView.
  - Create the TaskController from `window.api.getLayouts()`.
  - Replace the `Panel` instance with a facade object keeping the same method names: `show(id)` → `tasks.reveal`, `hide()` → `tasks.hide` of the drawer, `toggle()` → `tasks.toggleDrawer`, `activeView` → the active panel of the drawer stack, or null if collapsed. `setTitle` and `addView` → `dock.register`.
  - `showSidebar(v)` → `tasks.reveal(v)`.
  - Commands: `task.code|connect|debug|run` (Ctrl+Alt+1…4), `view.resetLayout` ("Reset Layout of This Task").
  - Save `task` in the workspace state and restore it per project.
  - `startDebugging` → `tasks.beginDebug(settings.switchToDebugTask)`; the session's end → `tasks.endDebug()`.
  - ▶ Run / ■ Stop button state follows the run state.
  - Project label shows "folder · branch".
- Modify: `src/renderer/graph/graphView.ts`:
  - It becomes a panel body: no overlay or close button; Esc only clears the search or selection.
  - `show()` becomes `refresh()`, called when the panel's onShow runs.
  - `openModule` → `tasks.switchTo('code')`, then open the file.
  - `view.projectGraph` (Ctrl+Alt+G) → `tasks.reveal('graph')`.
- Modify: `src/main/menu.ts`: View menu gets Code / Connect / Debug / Run, Edit Layout, Reset Layout of This Task. File menu keeps Open Folder.
- Modify: `src/renderer/styles.css`: remove sidebar/old panel/graph-overlay rules; add top-bar and task-switcher styles. Active task gets a hot outline + inset underline (spec), with no fill.
- Delete: `src/renderer/panel.ts`.
- Test: `src/renderer/dock/facade.test.ts` (happy-dom). The facade's `show`, `toggle`, `activeView` and `setTitle` behave like the old Panel for `terminal`, `problems` and `output`.

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `createPanelFacade(tasks: TaskController, dock: DockView): { show(id: string): void; hide(): void; toggle(): void; readonly activeView: string | null; isOpen: boolean; setTitle(id: string, t: string): void; addView(id: string, title: string, body: HTMLElement, actions: HTMLElement, onShow?: () => void): void }` in `src/renderer/dock/facade.ts`.

- [ ] **Step 1: Write the failing test** `facade.test.ts`:
  - `show('output')` makes output shown;
  - `toggle()` twice collapses then restores the drawer;
  - `activeView` is null while the drawer is collapsed;
  - `addView` registers a panel that `show` can reveal.
- [ ] **Step 2: Run** `npx vitest run src/renderer/dock/facade.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the facade, then the wiring listed under Files. Keep every existing `panel.*` / `showSidebar` call site working through the facade (no mass rewrite).
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: the UI lives in the dock; task switcher top bar"`

### Task 6: Edit Layout mode

**Files:**
- Modify: `src/renderer/dock/dockView.ts` (drag tabs in edit mode, drop-zone highlight), `src/renderer/dock/tasks.ts` (hooks), `src/renderer/main.ts` (command `view.editLayout`, floating bar), `src/renderer/styles.css`
- Create: `src/renderer/dock/editBar.ts` (the floating bar: Done, Reset this task, "Add panel ▾" listing `tasks.hiddenPanels()`)
- Test: extend `dockView.test.ts` and `tasks.test.ts`

**Interfaces:**
- Consumes: `zoneAt`, `movePanel` (Task 1); `TaskController.closePanel/addPanel/hiddenPanels/resetCurrent` (Task 4).
- Produces: `DockView.editing` drives the mode. While editing:
  - `body.classList` has `editing-layout`, and the grid shows across the window;
  - dragging a tab over a stack highlights the zone from `zoneAt` (an ember overlay covering that half or the centre);
  - dropping calls `hooks.drop`, which runs `movePanel` and re-renders.
  
  Esc or Done leaves the mode and saves.

- [ ] **Step 1: Write the failing tests:**
  - dockView: in edit mode, a simulated drag of the `problems` tab onto the right half of the `editor` stack calls `hooks.drop('problems', <editorStackId>, 'right')`; outside edit mode, tabs don't start drags.
  - tasks: `closePanel('where')` removes it and `hiddenPanels()` contains `'where'`; `addPanel('where')` places it back (by the reveal rules) and saves.
- [ ] **Step 2: Run** `npx vitest run src/renderer/dock`. Expected: FAIL.
- [ ] **Step 3: Implement** the drag, drop zones, edit bar and command (View → Edit Layout; no default shortcut).
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: Edit Layout mode"`

### Task 7: Where you are and In this file

**Files:**
- Create: `src/renderer/panels/whereModel.ts`, `src/renderer/panels/whereModel.test.ts`, `src/renderer/panels/whereView.ts`, `src/renderer/panels/inFileView.ts`
- Modify: `src/renderer/main.ts`:
  - One shared `projectGraph` state: scanned when a folder opens, rescanned 1.5 s after saving a `.py` file, and only while `where`, `infile` or `graph` is shown.
  - GraphView's `scan` hook reuses the same state.
  - The panels refresh when the active file changes.

**Interfaces:**
- Consumes: `ProjectGraph` (`src/shared/projectGraph.ts`), `layoutGraph` (`src/renderer/graph/layout.ts`).
- Produces:
  - `moduleForPath(g: ProjectGraph, relPath: string): string | null`
  - `neighbourhood(g: ProjectGraph, module: string): { module: string; imports: string[]; importedBy: string[]; hosts: string[] }`. Project imports only; `hosts` are the web API hosts it calls.
  - `fileSummary(g: ProjectGraph, module: string): { qual: string; kind: string; line: number; summary: string }[]`. One entry per top-level function or class and per method, in file order. `summary` reads like `"→ github · used by main, routes"`: "→" plus the hosts and modules it calls outside its own module, then "used by" plus the modules whose code calls it. Empty when it has neither.
- Views:
  - **Where you are:** a small SVG drawn with `layoutGraph`, with importers left and imports right, the current module in hot colour and web API hosts dashed. Click a node to open that module's file; double-click to switch to Connect and select it.
  - **In this file:** a list of `qual` with its summary; click to jump to the line.
  - Both show a short message when the file isn't Python or the project hasn't been analysed yet.

- [ ] **Step 1: Write the failing tests** `whereModel.test.ts`, built on the same small scan fixture style as `graph/viewModel.test.ts`:
  - `moduleForPath` maps `pkg/a.py` → `pkg.a` and `pkg/__init__.py` → `pkg`, and returns null for `notes.txt`;
  - `neighbourhood('pkg.a')` → imports `['pkg.b']`, importedBy `['tests.test_a']`, hosts `['api.x.com']`;
  - `fileSummary('pkg.a')` entry for `start` → `"→ api.x.com, pkg.b · used by tests.test_a"`, and `helper` → `""`.
- [ ] **Step 2: Run** `npx vitest run src/renderer/panels`. Expected: FAIL.
- [ ] **Step 3: Implement** the model, both views and the shared scan state.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Forge workspace: Where you are and In this file panels"`

### Task 8: Roadmap and version

**Files:** `docs/CHECKLIST.md`. Tier 4: mark done, noted "(v0.43: Forge task workspace)":
- "Design a distinctive workspace layout"
- "Rethink how files, terminals, graphs and debugging coexist"
- "Customisable workspace panels"
- "Dockable panels and floating windows" (note: docking yes, floating windows no)
- "Multiple workspace layouts"
- the Part 2 line

Also: `README.md` (the layout section).

- [ ] **Step 1: Run** `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: all pass.
- [ ] **Step 2: Update** the checklist and README.
- [ ] **Step 3: Commit** `git commit -m "v0.43: Forge task workspace (Part 2 of the Forge design)"`
