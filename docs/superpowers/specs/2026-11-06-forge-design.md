# Forge: visual identity, task workspace and the Connect stage

Date: 2026-11-06 · Status: draft for review
Mockups from the design session: `.superpowers/brainstorm/1239-1793968086/content/` (`palette.html`, `texture.html`, `window-v1.html`, `connect-v1.html`).

## Intent

IDEforfun becomes **Forge**: "the place where you forge code". Two things drive this redesign (roadmap Tier 4, plus the first part of 5.3):

1. **It should be interesting to look at.** That doesn't mean colour everywhere. The interest comes from a strong material language (a forge/smithy theme) and from heat that *means* something: what's active, running or connected glows, and everything else stays calm.
2. **The graph must be useful, not a gimmick.** It earns its place by letting someone connect an API to their project **without AI**: fill in a few fields, run one test call, tick the data you want, and get ordinary readable Python that saves it to a CSV.

Hard rule carried over from the roadmap: **the code is the source of truth.** Everything visual maps to real, readable code the user could have written by hand.

## Goals

- A distinctive look and feel (Molten colours + Smithy schematic shapes), with a plain high-contrast alternative.
- A workspace organised by **task** (Code · Connect · Debug · Run) instead of a VS Code-style activity bar.
- Panels the user can rearrange freely (move to any side, tab together, resize) in an **Edit Layout** mode, with a separate arrangement per task.
- A **Connect** task where the project graph is a working tool, with a first box type: the **API box**.
- Everything that works today keeps working (editor, split view, LSP features, git, debugger, tests, terminal, Project Graph features).

## Non-goals (for this project)

- Other box types (database, file, schedule…). The box system must be ready for them, but only the API box is built. They appear in the toolbox as greyed-out "coming later" entries.
- Other languages for generated code (Python only, as a proof of concept).
- AI anything.
- Pagination, OAuth flows, webhooks, GraphQL, or streaming APIs in the API box.
- A light colour theme. Dark Molten is the identity; a light "cold steel" variant may come later.

## Anti-goals

None named yet. The user wants to decide these after testing a first build, so the first build should be easy to adjust: colours, spacing and fonts in one set of tokens, not scattered through the code.

---

## Part 1: The Forge look

### Name
- The app is called **Forge** everywhere the user sees it: window title ("file — folder — Forge"), Welcome page, menus, About, the wordmark in the top bar.
- The repository and internal package names may stay as they are (builder's call).
- **Builder's call (my default):** project files move from `<project>/.ideforfun/` to `<project>/.forge/`. Forge reads `.forge/` first and falls back to `.ideforfun/`, and writes to `.forge/`. If `.ideforfun/` exists and `.forge/` doesn't, it is renamed on first open (with a one-line note in the status bar).

### Colour: "Molten" (default theme)
Deep warm brown-black surfaces, with a heat scale for active things. Starting tokens (from the chosen mockup; tune freely):

| Token | Value | Use |
|---|---|---|
| bg | `#120c0a` | window background |
| panel | `#170e0b` | editor, panels |
| raised | `#1d120e` | nodes, inputs, cards |
| line | `#3a2017` | borders, dividers |
| line-strong | `#5a3322` | node borders, focused dividers |
| fg | `#f3e2d4` | main text |
| fg-muted | `#8f7568` | labels, secondary text |
| heat-1 (spark) | `#ffcf5c` | brightest heat, sparks |
| heat-2 (hot) | `#ffb02e` | selection, active task, live state |
| heat-3 (ember) | `#ff6a1a` | primary buttons, accents |
| heat-4 (flame) | `#e8431d` / `#d2321e` | end of the heat gradient, errors share this family |

- Syntax colours in the same warm family: keywords `#ff6a3d`, functions `#ffc857`, strings `#e8a87c`, comments `#7a5f52`, decorators `#d9a35f`. The builder picks the rest; they must stay readable (WCAG AA against `panel`).
- **Gradients:** only the heat gradient (heat-1 → heat-4), and only on the FORGE wordmark and on *live* connection lines. **Never on buttons or anything clickable** (user decision). Buttons are solid.
- **Heat means state:** idle things are drawn in `line`/`fg-muted`; hot colours are reserved for what's selected, running, live or just connected. Nothing glows for decoration.
- Errors/warnings and git colours must stay distinguishable from "hot" (e.g. errors lean red-flame with an icon, warnings amber with an icon; never colour alone).

### Colour: "Plain" (setting)
- Black and white, high contrast, like VS Code's high-contrast theme: no heat colours, no glow, no grid, no sparks, no gradients.
- Same layout and shapes; only the paint changes. Plain syntax colours are allowed but muted; focus and selection use a strong outline.
- Chosen in Settings → Appearance → Theme: **Molten** (default) / **Plain**. Replaces today's dark/light toggle (the existing light theme is retired; settings with `light` map to Plain).

### Shape language: "Smithy schematic" (user's choice)
- **Square corners** everywhere (radius 0), thin warm outlines (1px `line`).
- **Corner marks**: panels and selected items get a small L-shaped ember mark in the top-left corner.
- **Blueprint grid**: a faint grid (`heat-3` at ~5% opacity, 18px) on stage/canvas areas only (graph, Connect canvas, Edit Layout mode), not behind code.
- **Angled buttons** (parallelogram clip, ~6px slant), solid fill. Primary: ember fill with dark text; secondary: raised fill with hot text.
- **Active tab / task**: hot outline plus a 2px hot underline (inset), no fill.
- **Selected graph node**: hot border + hard offset shadow (3–4px, ember at ~35%), no blur.
- **Sparks**: small bright dots that travel along a connection line, **only while something is actually live** (a request in flight, a connection just made, the program running through that path). Respect "reduce motion": no sparks, no animation.
- **Section labels**: 9–10px uppercase with wide letter spacing, muted.

### Type
- UI: **Space Grotesk**. Code: **JetBrains Mono**. Both are bundled with the app (works offline), both under the OFL licence.
- Code font size and line height stay user settings, as today.

---

## Part 2: The task workspace

### Top bar
`[Forge wordmark] [Code] [Connect] [Debug] [Run]  ……  [project · branch]  [▶ Run]`
- The **task switcher** is the main navigation. It replaces the sidebar tab strip and the toolbar's Open Folder/Run/Debug/Stop buttons (those move to the menu, the palette, the Welcome page, and the ▶ Run button, which becomes ■ Stop while running).
- Shortcuts to switch task (builder's call, e.g. Ctrl+Alt+1–4), plus palette commands.
- The status bar stays at the bottom, restyled.

### Panels
Every part of the window is a **panel** with an id, a title and a body:
Files, Search, Outline, Git, History, the code editor area (with its split groups and tabs), Where you are (mini map), In this file, Project Graph, Connect canvas, Box settings, Box toolbox, Terminal, Problems, Output, Debug (call stack / variables / watch / breakpoints, possibly as separate panels), Tests, References, Calls.

The current fixed layout (sidebar + editor + bottom panel) is replaced by a **dock layout**: a tree of horizontal/vertical splits whose leaves are **tab stacks** of panels.
- Any panel can be moved to any side of any other panel, or into its tab stack.
- Split dividers can be dragged to resize.
- The code editor area is a panel like the others but can't be closed.

### Tasks = saved arrangements
- Each task has **its own arrangement**, so switching task swaps the whole arrangement. Panels keep their state (scroll, selection, terminal sessions) when they move or are hidden.
- Default arrangements (builder may refine):
  - **Code** (mockup `window-v1.html`, adjusted by the user): **Files as its own tab on the left** (tab stack with Search, Outline, Git), the editor in the centre, a right column with Where you are + In this file, and the Terminal/Problems/Output drawer under the editor.
  - **Connect** (mockup `connect-v1.html`): Box toolbox (narrow, left), Connect canvas (centre), Box settings (right); editor hidden; Terminal drawer collapsed.
  - **Debug**: editor centre; Variables/Watch right; Call stack + Breakpoints right-bottom; Debug console drawer bottom.
  - **Run**: editor left; Output and Tests on the right or bottom; Terminal drawer.
- Starting a debug session switches to the Debug task, and ending it switches back to the previous task (setting to turn off). Running doesn't switch task.
- **Reset layout**: per task, back to its default.
- Arrangements are saved **per user**, not per project (in userData).

### Edit Layout mode (View → Edit Layout)
- Like Roblox Studio's window docking: in this mode the blueprint grid shows across the whole window, panels show their corner marks, title and a drag handle, and dividers become thicker handles.
- Dragging a panel shows **drop zones** (left/right/top/bottom of a target panel, or its centre to tab into it), highlighted in ember as you hover. Dropping rearranges the dock tree.
- A small floating bar shows: **Done**, **Reset this task**, and a list of hidden panels to add back.
- Panels can be closed (hidden) from their tab; the code editor can't.
- Outside Edit Layout mode, dividers can still be dragged to resize. Moving panels needs the mode, so the normal workspace stays calm and can't be rearranged by accident.
- Keyboard: Esc or Done leaves the mode.

### Where you are (new panel)
- A small graph of the current file's module: what it imports (right) and what imports it (left), plus API boxes connected to it. Click a node to open that file; double-click to open it in the Connect task.
- Same data as the Project Graph (no extra analysis), refreshed when files are saved.

### In this file (new panel)
- The current file's functions and classes, each with a one-line summary of connections ("→ github · used by main, routes"), from the Project Graph data. Click to jump.

---

## Part 3: Connect and the API box

### Connect canvas
- The **Project Graph** (v0.41) becomes the Connect canvas: same analysis, same modules/calls views, same findings. The current overlay view is retired in favour of this panel. **There is one graph panel** (called "Graph"; "Connect canvas" in this document is the same panel). It lives in the Connect task by default; API boxes always show in it. The toolbox and Box settings are separate panels. *(Builder's call, settled after review.)*
- **Code from Connect:** the Connect task has no editor by default (in the dock model "hidden" means "not placed in this task's arrangement"; the editor just can't be removed from the **Code** task). Double-clicking a node, or "Open" in the details, **switches to the Code task** and opens the file there. "Where you are" double-click does the reverse: switches to Connect and reveals that module. *(Builder's call.)*
- **Box toolbox**: box types to drag onto the canvas. Only **API** is enabled; Database / File / Schedule are shown greyed out with "coming later".
- **Box placement:** the graph stays automatically laid out (v0.41 layout). A box has no free position: it is **attached to the node it's wired to** and drawn just to its right (stacked if several). In the Calls view that's its function; in the Modules view, its module. So boxes never drift away from their code after a re-layout. *(Builder's call; `boxes.json` therefore stores no canvas position.)*
- **Boxes** are drawn differently from code nodes: hot outline, title, a one-line summary (`GET api.github.com/users → users.csv · 2 of 5 fields`), and a status dot (not tested / tested OK / failing). A box is wired to the function it generated, and that wire is "live" (heat gradient + sparks) while a test call runs.
- Selecting a box opens **Box settings**.

### Several APIs in one box (user decision)
An API box can hold **several requests**, and **each request writes to its own CSV file**. Example: a "GitHub" box with *Users* → `users.csv` and *Repos* → `repos.csv`.
- **Shared by the whole box** (my call): name, base URL (optional), auth, and the target Python file.
- **Per request:** its own name, method, path/URL, parameters, headers, body, test call, tick boxes, function name and CSV output.
- Box settings show the box-level fields at the top and the requests as a list/tabs below (`+ Add request`). The box on the graph shows one line per request (`GET /users → users.csv · 2 of 5 fields`) and its status dot per request.
- Generated code: **one function per request** in the box's target file (e.g. `github_users()`, `github_repos()`), sharing one small helper for the base URL and auth. With more than one request, the file's `__main__` block runs all of them. *(My call.)*

### API box settings (user's design)
Fields (per request unless marked "box"):
- **Box name** (box) and **request name**, which together give the function name (e.g. "GitHub" + "users" → `github_users()`), editable.
- **Method** (GET, POST, PUT, PATCH, DELETE) and **URL**.
- **Query parameters** (key/value rows) and **headers** (key/value rows).
- **Body** (for POST/PUT/PATCH): JSON text.
- **Auth** (box): None / API key in header (header name) / API key in query (param name) / Bearer token / Basic. Secrets go into the project's `.env` under a name the user can edit (default derived from the box name, e.g. `GITHUB_TOKEN`). The generated code reads them from the environment and **never contains the secret**. Forge offers to add `.env` to `.gitignore`.
- **Arguments:** `{placeholders}` in the URL (e.g. `/users/{username}`) become **function parameters**; every query parameter row has an "argument" tick to turn it into a parameter (default value = the value typed). The function always also takes `output_path` defaulting to the configured CSV path. With none of these, the function is just `github_users(output_path="users.csv")`. *(Builder's call.)*
- **Writes to** (box): a target file. Either a **new file** (default `api/<name>.py`) or **append to an existing file**, plus the function name.
- **Output**: CSV path (default `<name>.csv` in the project root, editable).

### Test call
- **⚡ Test call** runs the request once, from Forge itself (main process), using the values from `.env`.
- Shows status, item count and time (`✓ 200 OK · 50 items · 0.4 s`), or the error.
- Reads the JSON response and builds the **field list**:
  - If the response is a list of objects, the fields are those of its items (merged over all items, so optional fields show up).
  - If it's an object containing a list (e.g. `{"items": [...]}`), Forge picks the largest list of objects as the **records** and lets the user change it ("Records from: items ▾"). If there's no list, the object itself is one record.
  - Nested objects appear as **indented, foldable tick boxes** (`plan ▸ name`). Lists inside a record are offered as one column holding the list as JSON text.
- Every field gets a **tick box** and a sample value. By default all top-level plain fields are ticked and nested ones are not (my call).
- A **preview** shows the first rows of the CSV exactly as it will be written.
- Responses over a size cap (e.g. 5 MB) and non-JSON responses are reported clearly; for non-JSON, the API box can only save the raw text (no tick boxes).

### Generating the code
- The **first** time, **Write code** shows a preview of the Python (roadmap rule), then inserts it. After that, changes in the box update the code automatically (see below).
- The generated function, for the user's example: calls the API, keeps only the ticked fields, and writes a **well-formatted CSV** (header row with the field names, nested names joined with dots such as `plan.name`, UTF-8, standard `csv` module quoting). It also returns the rows, so the user can call it from code as well.
- **Secrets at run time:** generated code reads them with `os.environ`, and if one is missing it raises a clear error naming the variable and saying to add it to `.env`. Forge **loads the project's `.env` into the environment of Run, Debug, Tests and new terminals** (like VS Code's Python extension does), so generated code works inside Forge with no extra dependency. Variables already set in the environment win over `.env`. *(Builder's call; this is a small general feature in Part 3.)*
- Plain, readable Python a person could have written: `requests` (or `urllib` if the builder prefers to avoid the dependency; if `requests` is used and isn't installed, Forge offers to install it with the existing packages feature), `os.environ` for secrets, `csv.DictWriter`. Includes a small `if __name__ == "__main__":` block in new files so the file can be run directly.
- The generated block is marked with comment lines, e.g. `# forge:box github-users (generated, edit in Forge or here)` … `# forge:end`, so Forge can find and update it.

### Keeping box and code in sync
- Each box's settings are saved in the project: `.forge/boxes.json` (box id, type, fields, target file/function, output path, ticked fields, attached node). Secrets are never stored there, only the `.env` variable names.
- **Box → code is automatic (user decision).** Any change in the box (fields, ticks, adding/removing a request…) rewrites the marked block right away, without an Update button. My calls on the details: the rewrite happens when a field is committed (Enter, leaving the field, ticking a box), not on every keystroke; it's applied to the editor's buffer as one undoable step (and saved like a normal edit), and the status bar notes "Updated github.py from the GitHub box".
- **Code → box is not read back.** Sync goes one way: the box is the source of the generated block. If the user has hand-edited the block since Forge wrote it (detected with a hash of the generated text stored in `boxes.json`), the automatic rewrite **stops for that box**: the box shows "code edited by hand", with **Overwrite with box** (shows a diff first) and **Keep my edits** (the box detaches from that block and stops updating it, until the user re-attaches it). *(The keep/overwrite behaviour is my call; the user asked only that box changes update the code.)*
- If the marked block is deleted from the code, the box shows "code missing" and offers to write it again or remove the box.
- Removing a box offers to remove its generated code too (roadmap 5.3).

---

## Constraints

- Hand-written UI, like the rest of the app (no UI framework, no docking or graph library). The Project Graph layout code from v0.41 is reused.
- Electron + TypeScript; renderer has no Node access, and new main-process abilities (the test-call request, writing `.env`) go through typed IPC in `src/shared/api.ts`.
- The test call is a real network request with the user's secret. It only happens when the user presses the button, and only to the URL in the box.
- Performance: switching task must feel instant (no re-creating editors or terminals; panels are moved, not rebuilt).
- Existing user state must migrate: settings, keybindings, recent projects, per-project workspace state (open tabs, splits, breakpoints…).
- Unit tests for the pure parts, as elsewhere in the repo: the dock tree operations, the response → field list → CSV rows logic, the code generator (single and multi-request boxes), and the box/code sync (marker finding, hash check, detach). The user's rule stands: no in-app/e2e test runs unless they ask.

## Left to the builder

- Exact sizes, spacing, icon set (simple line icons that fit square corners), and syntax colours beyond those listed.
- How Debug's views split into panels.
- Shortcut choices for task switching and Edit Layout.
- `requests` vs `urllib` for generated code (state which and why).
- Order of work inside each part, and whether Part 1 ships as one version or several.

## Order of work

1. Part 1 (look) can ship on the current layout first, so the identity can be tested early (the user wants to decide anti-goals after testing).
2. Part 2 (task workspace + dock layout + Edit Layout).
3. Part 3 (Connect canvas + API box).
