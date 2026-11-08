# IDE Roadmap

Work through the roadmap roughly top to bottom. Each tier builds on the foundations above it.
The checklist is meant to evolve as the IDE develops; priorities are guidance rather than a
strict implementation order.

**Core principle:** the code is the source of truth. Every visual element must be traceable back
to real source code or runtime behaviour.

## Tier 1: Core editor

- [x] Open a folder, show the file tree, expand/collapse folders (v0.1)
- [x] Create, rename and delete files and folders from the tree (v0.16)
- [x] Open a file and render its text with line numbers in a monospace font (v0.1)
- [x] Text buffer model: insert, delete, line/column ↔ offset
- [x] Cursor movement: arrows, Home/End, PgUp/PgDn, click to place
- [x] Typing, Backspace/Delete, Enter (with Python auto-indent after `:`)
- [x] Selection (shift+arrows, mouse drag, double/triple-click, Ctrl+A), copy/cut/paste, Tab/Shift+Tab indent (v0.4)
- [x] Save (Ctrl+S), dirty marker, warning about unsaved changes on close (v0.2)
- [x] Undo/redo (v0.3)
- [x] Scrolling that only renders visible lines (50k lines opens in ~80ms, v0.5)
- [x] Multi-cursor editing (v0.18: Alt+click, Ctrl+Alt+↑/↓, Ctrl+D, Ctrl+Shift+L; paste spreads lines across cursors)
- [x] Bracket matching and automatic bracket completion (v0.19: highlight the pair, Ctrl+Shift+\ to jump, Enter between brackets, Backspace deletes empty pairs, wrap a selection)
- [x] Automatic quote completion (v0.19: skips apostrophes, understands f""/r"" prefixes and """docstrings""")
- [x] Comment/uncomment selection (v0.19: Ctrl+/)
- [x] Code folding (functions, classes and blocks) (v0.20: gutter arrows, Ctrl+Shift+[ / ], Fold All / Unfold All; folds follow edits)
- [x] Minimap (v0.21: token colors, on-screen box, click/drag to scroll, follows folds; "Toggle Minimap" in the palette)
- [x] Multiple editor groups / split view (v0.22: two side-by-side groups with their own tabs and cursors; Ctrl+\, Ctrl+1/2, Move Tab to the Other Side)
- [x] File encoding detection and conversion (v0.23: UTF-8, UTF-8 with BOM, UTF-16 LE/BE, Western; Reopen / Save with Encoding)
- [x] CRLF/LF line endings: shown in the status bar, click to convert (v0.23)
- [x] Large-file mode and graceful handling of binary files (v0.23: binary files ask first; over 5 MB skips the language server; over 50 MB asks; over 256 MB refused)
- [x] Recovery of unsaved buffers after unexpected crashes (v0.24: backups of unsaved files, offered back when the folder is next opened)

## Tier 2: IDE foundations

- [x] Tabs for several open files (v0.6)
- [x] Python syntax highlighting (own tokenizer, v0.5)
- [x] Find/replace in the file (case, whole word, regex with $1 groups, v0.7)
- [x] Run the current Python file and show its output in a panel (F5, auto-save, venv detection, `input()`, clickable tracebacks, v0.8)
- [x] Integrated terminal (xterm.js + node-pty, Ctrl+`, v0.9)
- [x] Command palette (Ctrl+Shift+P), quick open (Ctrl+P), go to line (Ctrl+G) (v0.11)
- [x] Settings (font size, theme, tab width, Python interpreter, Ctrl+= / Ctrl+-) (v0.10)
- [x] Multiple terminal sessions (v0.25: + / ▾ / 🗑 buttons, list on the right, Ctrl+Shift+`)
- [x] Terminal profiles and shell selection (v0.25: finds PowerShell, PowerShell 7, Command Prompt, Git Bash, WSL / bash, zsh, fish; default in Settings)
- [x] Configurable keyboard shortcuts (v0.26: press new keys from Keyboard Shortcuts…, clashes marked, keybindings.json, menu follows)
- [x] Recent projects (v0.26: File → Open Recent, Ctrl+R, listed in the sidebar with no folder open)
- [x] Workspace persistence (restore tabs, terminal sessions and layout) (v0.26: tabs, split, cursors, terminals' shells, bottom panel; last project reopens at startup)
- [x] Project-specific settings (v0.26: .ideforfun/settings.json can set tabSize, pythonPath, shell)
- [x] Task runner for predefined project commands (v0.27: tasks in .ideforfun/run.json, Ctrl+Shift+B, each in its own terminal)
- [x] Run configurations (arguments, environment variables and working directory) (v0.27: file or module, for Run and Debug, picked in the status bar)
- [x] Python environment management (create, select and manage virtual environments) (v0.28: 🐍 in the status bar, finds venvs and installed Pythons, creates .venv, saved per project)
- [x] Dependency management integration (pip, requirements.txt, pyproject.toml) (v0.28: Python Packages…, missing-package warning, install/upgrade/uninstall, freeze)
- [x] Updates (v0.46: the installed app checks GitHub Releases after starting or from Help → Check for Updates, asks, downloads in the background and restarts into the new version; the portable version opens the download page; see docs/RELEASING.md)
- [x] Test runner integration (pytest, unittest) (v0.29)
  - [x] Test discovery and running individual tests (reads test files; ▶ per test / file, Run Test at Cursor)
  - [x] Test results panel with navigation to failures (Tests tab: ✓ ✗ per test, click to the failing line, full traceback)

## Tier 3: Intelligence and developer tooling

- [x] Language Server Protocol client (Pyright)
  - [x] Diagnostics and errors (v0.13)
  - [x] Autocomplete (v0.14)
  - [x] Hover information and go-to-definition (v0.15)
- [x] Search across the project (Ctrl+Shift+F, case / word / regex, v0.12)
- [x] Git status in the file tree (M/U/A/D badges, folder dots, auto-refresh, v0.12)
- [x] Debugger (DAP, debugpy): breakpoints, stepping, call stack, variables, debug console with expression evaluation, hover values, pause on uncaught exceptions (v0.17)

Language features (Pyright already does the analysis for most of these; they're mostly UI work):
- [x] Find references (v0.31: Shift+F12, References tab with line previews)
- [x] Rename symbol across project (v0.31: F2; open files undoable, closed files changed on disk after confirming)
- [x] Go to implementation (v0.34: Ctrl+F12, Python-style: subclasses of a class, overrides of a method; also Go to Type Definition, Ctrl+T symbols in the project, other uses of a name highlighted)
- [x] Call hierarchy (v0.34: Shift+Alt+H, Calls tab, incoming / outgoing, expands step by step)
- [x] Document symbols / outline panel (v0.31: Outline sidebar tab follows the cursor, filter; Ctrl+Shift+O)
- [x] Import organisation and automatic import suggestions (v0.33: Shift+Alt+O with Ruff, or Pyright's; auto-import suggestions in completion since v0.13)
- [x] Code actions and quick fixes (v0.33: Ctrl+. / 💡: Ruff fixes, Pyright code actions, # noqa, fix all)
- [x] Format document / selection (Black, Ruff) (v0.33: Shift+Alt+F, Format Selection, format on save)
- [x] Linting integration (Ruff) (v0.33: as you type, in Problems and squiggles, uses the project's Ruff config)
- [x] Semantic syntax highlighting (Pyright doesn't provide semantic tokens; needs basedpyright or our own analysis) (v0.46: the bundled server is now basedpyright (Pyright plus semantic tokens; checks set to Pyright's 'standard'); parameters, properties, classes, modules and constants coloured by what they are, over the tokenizer's colours)
- [x] Language-support architecture: language integrations instead of Python-specific editor logic, so several language servers can run side by side (groundwork for Tier 6.2) (v0.39: each file has a language that sets its highlighting, comment marker and Enter-indent; language servers run by id side by side and each file goes to its language's server; new JSON/JSONC, TOML, YAML and INI highlighting)

Git:
- [x] Git diff viewer (v0.35: click a changed file; colored, line numbers, Python highlighting)
- [x] Stage/unstage individual hunks (v0.35: Stage / Unstage / Discard Hunk in the diff)
- [x] Commit interface (v0.35: Git tab, Ctrl+Enter, amend, stage-all offer; fetch / pull / push)
- [x] Branch switching and creation (v0.35: ⎇ in the status bar or Git tab; local, new and remote branches)
- [x] Merge conflict resolution (v0.36: shaded sides, Accept Current / Incoming / Both bar, next / previous, save and mark resolved)
- [x] Git history and file blame, with a graph view (v0.36: History tab with graph, commit files and diffs, file history; blame in the status bar and gutter)

Debugger improvements:
- [x] Support `input()` while debugging (run the debugged program in a terminal) (v0.37: runInTerminal; setting to use the Debug console instead)
- [x] Conditional breakpoints (v0.37: condition, hit count, log message, on/off; right-click a line number)
- [x] Watch expressions (v0.37: Watch section, re-evaluated on every pause, expandable)
- [x] Option to pause on every raised exception, not just uncaught ones (v0.37: Breakpoints section checkboxes, Run menu)
- [x] Breakpoint management panel (and keep breakpoints between sessions) (v0.37: Breakpoints section; saved per project with watches)
- [x] Debug multiple processes (v0.37: threads are listed and selectable; v0.40: child processes (multiprocessing, subprocess running Python) are attached automatically, with a Processes list; breakpoints work in them and whichever process pauses comes to the front)

## Tier 4: Visual identity and workspace

The IDE is now **Forge** (design: docs/superpowers/specs/2026-11-06-forge-design.md).

Goal: give the IDE a distinctive identity rather than reskinning a conventional editor layout.
Best started once a first graph view exists (5.1), so the layout is designed around real visual tools.

- [x] Design a distinctive workspace layout (v0.43: Forge task workspace)
- [x] Rethink how files, terminals, graphs and debugging coexist (v0.43: tasks Code / Connect / Debug / Run, each with its own arrangement)
- [x] Customisable workspace panels (v0.43: Edit Layout mode: move, close, add back, reset)
- [x] Dockable panels and floating windows (v0.43: docking done, drag tabs to any side or into another panel; v0.46: ⧉ on a panel opens it in its own OS window, Back to the dock or closing the window returns it; the editor and terminal stay docked)
- [x] Multiple workspace layouts (coding, debugging and visualisation) (v0.43: Forge task workspace)
- [x] Context-aware interface that surfaces relevant tools for the current task (v0.46: suggestions in the top bar from what you're doing: Network for a file calling web APIs, Pipeline for tables, Tests, Debug it after a failed run, Problems, Git)
- [x] Customisable information density (v0.46: Settings → Density: Compact, Normal or Roomy panels and bars (the editor and terminal follow the font size))
- [x] Animated transitions between workspace states (v0.46: switching task, and moving / adding / closing panels (Settings → Animations; off with reduced motion))
- [x] Visual navigation through projects (v0.46: Project Map (Ctrl+Alt+M): every Python file sized by its lines, grouped by folder; open, problem, changed and recent files marked; type to find, click to open)
- [x] Consistent visual language for graphs, code, debugging and terminal (v0.42: Forge look: Molten / Plain themes, Smithy schematic shapes, bundled fonts)
- [x] Forge task workspace: Code / Connect / Debug / Run, movable panels, Edit Layout mode (Part 2 of docs/superpowers/specs/2026-11-06-forge-design.md) (v0.43: Forge task workspace); Where you are and In this file panels
- [x] Live run feedback on the graph (v0.45: traced ▶ Run with the Graph in view; Settings → Runs on the graph): while the program runs, sparks travel along the connections and the running boxes glow (Molten); a dot and a highlight in Plain. Needs runtime tracing of calls (see 5.2 / 5.5). Requested 2026-11-06
- [x] Connect task and the API box (Part 3 of the same spec; also covers parts of 5.3) (v0.44: Toolbox, Box settings, test call, tick boxes, CSV code kept in sync; .env loaded into Run / Tests / Debug / terminals)

## Tier 5: Visual programming environment

Visualisations are interactive representations of real code, not a separate programming system.

### 5.1 Project intelligence graph
- [x] Parse the project using Python's `ast` (a helper script run with the project's own Python) (v0.41: Ctrl+Alt+G / View → Project Graph)
- [x] Build a project dependency graph: files, modules, classes, functions, imports (v0.41: absolute, relative and submodule imports; packages used)
- [x] Function-to-function call relationships (v0.41: Calls view; local, imported, module.func, self.method, Class().method)
- [x] Detect API endpoints called (`requests`, `httpx`, `aiohttp`) (v0.41: incl. sessions/clients; shown as web API nodes by host)
- [x] Detect API routes (FastAPI, Flask)
- [x] Detect environment variables (os.environ[...], os.getenv, environ.get)
- [x] Display dependencies between components (v0.41: hand-written layered SVG layout, pan / zoom / fit)
- [x] Click a graph node to navigate to its source code (double-click; details on single click)
- [x] Highlight a node's dependencies and dependants (hover or select: uses in blue, used by in orange)
- [x] Filter graph by type, file or relationship (v0.41: Modules / Calls, one module's calls, name filter, tests / packages / web APIs toggles)
- [x] Detect circular imports (red edges; listed in the findings)
- [x] Identify unused functions and potentially unreachable code where statically determinable (v0.41: possibly unused functions/classes listed and struck through; v0.46: "Code that never runs" in the Graph findings, on modules and on functions: after return / raise / break / continue, after an if/else or try whose branches all stop, and under `if False:`)

### 5.2 Live network visualisation
- [x] Runtime instrumentation for `requests`, `httpx` and `aiohttp` (v0.46: the run tracer hooks http.client (urllib, requests/urllib3), httpx (sync and async) and aiohttp; secrets masked before they leave the program)
- [x] Capture socket-level connections where appropriate (v0.46: other TCP connections (databases, websockets...) as CONNECT host:port)
- [x] Stream runtime events to the IDE (v0.46: net records over the trace socket, re-sent as they fill in)
- [x] Animated network graph (v0.46: a spark from the code to the web API node or API box, green ok / red failed)
- [x] Display HTTP method, URL, status and response time (v0.46: Network panel)
- [x] Click a connection to inspect request/response details (v0.46: headers and the first 4 KB of each body)
- [x] Request history and filtering (v0.46: this run and the last; filter by text, failed or slow)
- [x] Group requests by host and originating function (v0.46)
- [x] Identify failed requests and slow endpoints (v0.46: red, and slow (1 s+) marked; Failed / Slow filters)
- [x] Timeline showing when requests occurred (v0.46: bars on lanes above the list)
- [x] Compare network activity between runs (v0.46: endpoint by endpoint: new, gone, failing, slower, faster, more / fewer calls)

### 5.3 Visual API integration
- [x] Drag from a file/function to an unconnected API (v0.44: drag the API box from the Toolbox onto a module)
- [x] Generate client modules and imports (v0.46: Add API from OpenAPI writes a client module and can add its import to the open file)
- [x] Generate `.env` keys (v0.44: API box)
- [x] OpenAPI / Swagger support (v0.46: OpenAPI 3 and Swagger 2, JSON or YAML, from an address or a file (Toolbox → OpenAPI client))
  - [x] Generate functions for individual endpoints (v0.46: pick the endpoints; typed parameters)
  - [x] Generate request and response models (v0.46: a dataclass per schema, with from_dict / to_dict)
  - [x] Generate authentication handling (v0.46: API key, bearer token or user name and password, from .env)
- [x] Support APIs without specifications (v0.44: API box)
  - [x] Generate base URL configuration
  - [x] Generate authentication configuration
  - [x] Generate an example request (the generated function, and the test call)
- [x] Preview generated code before applying changes (v0.44: API box)
- [x] Ensure visual changes generate normal, readable Python (v0.44: standard library only)
- [x] When removing a visual connection, offer to remove associated code (v0.44: API box)
- [x] Detect changes to generated code and update graph relationships (v0.46: the scan marks generated clients and whether they were edited (and regenerating asks first); urllib calls built from a module's BASE_URL link to that host)
- [ ] Later: AI-assisted API documentation interpretation and integration

### 5.4 Data-flow visualisation
- [x] Trace data between functions (v0.46: traced runs record what goes into and comes out of each function (first two calls), and Run with data records each line of one function)
- [x] Visualise function inputs and outputs (v0.46: Last run in a function's Graph details; inputs on the Pipeline's input boxes)
- [x] Show where variables originate (v0.46: Pipeline view: wires from where each value was set; Where its data comes from)
- [x] Show transformations applied to data (v0.46: each step shows what it made and what changed (rows, columns, groups))
- [x] Highlight data dependencies (v0.46: hover or select a step: what it depends on and what depends on it)
- [x] Interactive pipeline graph (v0.46: Pipeline panel (Connect task, or Data flow on a function in the Graph))
- [x] Pandas DataFrame pipeline visualisation (v0.46)
- [x] Inspect DataFrame shapes, columns and types (v0.46)
- [x] Preview intermediate DataFrame contents (v0.46: the first rows of each step's table)
- [x] Visualise data filtering, grouping and merging (v0.46: 1,204 → 873 rows, 100 rows → 4 groups, columns added / removed)
- [x] Export visual pipelines as ordinary Python (v0.46: pipelines are ordinary Python; Export writes a script with the built-in blocks copied in)

Block library (for the pipeline graph): blocks are whole steps, not single statements, so graphs stay small and map cleanly to code.
- [x] Each block is an ordinary Python function; inputs and outputs come from its parameters, type hints and return value (v0.46)
- [x] Placing a block inserts a readable call (plus import); wiring blocks passes one block's result to the next (v0.46: click a data input to take it from another step; click a setting to change it)
- [x] Built-in library of useful steps (read CSV/JSON, filter rows, group by, call API endpoint, retry, save) (v0.46: forge_blocks.py (pandas): read CSV / JSON, call API, filter, select, rename, add column, sort, group, merge, de-duplicate, fill missing, retry, save CSV / JSON)
- [x] User blocks: mark a project function (e.g. `@block` or `.ideforfun/blocks/`) and it appears in the library (v0.46: @block, or any function in a blocks.py)
- [x] Editing a block opens its Python; editing a built-in makes a project copy first, so library updates never overwrite it (v0.46: a built-in is copied into the project's blocks.py first)
- [x] A single "for each" container block instead of loop/if wiring (v0.46: For each… runs a block on every item (or row) of a step's result)

### 5.5 Execution visualisation
- [x] Live call graph while debugging (v0.46: at each pause the paused function glows, the stack and its calls are marked, calls not seen before get a spark)
- [x] Animated function execution (v0.45 live during ▶ Run; v0.46: ▶ Replay of the last traced run with a slider and speed)
- [x] Visualise recursion trees (v0.46: the tracer records the calls of a recursive function (arguments in, value returned); Last run in the node's details opens the tree)
- [x] Show current execution position on the graph (v0.45, during ▶ Run; v0.46 while debugging too)
- [x] Display live variable values on nodes (v0.46: a card beside the paused function)
- [x] Track variable changes over time (v0.46: History in the function's details, changes marked)
- [x] Visualise object relationships (v0.46: Objects on the card: boxes and reference arrows from a helper run in the paused frame)
- [x] Inspect object properties without opening debugger panels (v0.46: objects open in place on the card)
- [x] Compare variable states between execution points (v0.46: compare any two pauses: changed, new, gone)
- [ ] Someday (research): execution timeline with step-back (Python can't run backwards, so this means recording everything as it runs)

## Tier 6: Advanced capabilities (someday)

Each of these is a big project of its own. Kept as a wishlist.

### 6.1 Extensibility
- [ ] Extension / plugin architecture
- [ ] Public extension API
- [ ] Custom language integrations
- [ ] Custom visualisation plugins
- [ ] Custom themes and icons
- [ ] Extension marketplace
- [ ] Extension isolation and permission model

### 6.2 Multi-language support
- [ ] JavaScript / TypeScript
- [ ] Rust
- [ ] C / C++
- [ ] Go
- [ ] Generic LSP integration for other languages
- [ ] Language-specific debugging adapters
- [ ] Language-specific visualisation providers

### 6.3 Advanced Git and collaboration
- [ ] GitHub integration
- [ ] Pull request browsing
- [ ] Review comments and inline code review
- [ ] Branch comparison
- [ ] Visual merge resolution
- [ ] Collaborative editing
- [ ] Shared debugging sessions
- [ ] Live project-state sharing

### 6.4 Developer automation
- [x] Project templates and custom scaffolding (v0.50: File → New Project from Template…: Script, Command-line tool, FastAPI, Flask, Data analysis, Tkinter, Package with tests; Save Project as Template… for your own, with the project's name as a placeholder)
- [ ] Build-system integration
- [ ] Docker integration
- [ ] Remote development over SSH
- [ ] Container-based development environments
- [ ] Background task execution
- [ ] Automated project health checks

## Additional feature ideas

Optional directions that could extend the IDE beyond the core roadmap.

**Architecture explorer**
- [x] Automatically reconstruct the architecture of an unfamiliar codebase (v0.41: the Project Graph is built from the code with Python's `ast`, nothing to set up)
- [x] Show components, dependencies, entry points and communication paths (v0.41: modules, imports, calls, programs with `__main__`, web routes and the web APIs they call)
- [x] Provide a visual map of how the project works (v0.46: Project Graph, plus the Project Map overview)

**Visual profiler**
- [x] Show execution time directly on the project graph (v0.47: after a traced run, each function (Calls) or file (Modules) shows its time; Times toggle in the Graph toolbar)
- [x] Highlight expensive functions (v0.47: warmed by their own time, not the calls they make; "Slowest in the last run" in the Graph's findings and in each module)
- [x] Display call paths to explain where time is spent (v0.47: a function's details: "Where the time comes from", the heaviest callers from the start of the program)

**Database explorer**
- [x] Detect database connections and ORM models (v0.48: SQLAlchemy, SQLModel, Django and Peewee models; CREATE TABLE in SQL strings; sqlite3, SQLAlchemy engines, psycopg, MySQL, Mongo, Redis connections, passwords masked; SQLite files in the project read as they really are, read-only)
- [x] Generate interactive schema diagrams (v0.48: Database panel in the Connect task: tables with columns and keys, pan / zoom / fit)
- [x] Show database relationships (v0.48: foreign keys from the key's row, many-to-many dashed, relationship() dotted where no key links them)
- [x] Navigate from schema elements to relevant code (v0.48: double-click a table to open its model; "Used in" lists the functions that use it; connections open where they're made)

**Event-flow visualiser**
- [x] Track events through an application: where they originate, which handlers process them, what gets triggered and where they end up (v0.48: the Graph's Events view: code that emits each event (or "from outside the code"), its handlers and what they call; handlers from decorators (@sio.on, @client.event, @receiver, @app.task...), .on() / .connect() / .bind() / command=, emit() / send(sender=) / delay(); sparks through the event as it runs)
- [x] Support asynchronous and event-driven applications (v0.48: work started with asyncio.create_task / gather / run, Thread(target=), Timer, executor.submit, run_in_executor, call_soon / call_later, to_thread)

**Memory explorer**
- [x] Visualise object references, memory allocations and object lifetimes (v0.48: Memory panel, Run with Memory Tracking: where memory is allocated, by your line and function; how many objects of each of your classes are alive over the run. Object references: v0.46's Objects on the debugger's card)
- [x] Inspect memory usage during execution (v0.48: memory in use over the run, as it runs, with the peak)
- [x] Identify unexpected object retention (v0.48: classes whose objects keep growing are flagged; at the end, what keeps them alive, e.g. app.CACHE → list)

## Suggested implementation priorities

A suggested order based on dependencies and practical value, not a requirement to complete every item in sequence.

1. Remaining Tier 1 and Tier 2 items, top to bottom (multi-cursor and folding early: they change the editor's core)
2. Cheap Tier 3 language features that Pyright already supports (references, rename, outline, quick fixes, Ruff formatting)
3. Git diff and commit interface: completes a major everyday workflow
4. Architecture explorer (rough first version): the first genuinely distinctive visual feature
5. Tier 4 redesign, shaped around that first graph view
6. Runtime instrumentation: connects static code understanding with actual execution
7. Interactive data-flow graph: builds on static and runtime intelligence
8. Visual API integration: turns visualisation into an editing capability
9. Plugin architecture: makes future expansion easier

## Architectural recommendation

Before building too much of Tier 5, create an internal **Project Model** that sits between the parser,
LSP, debugger and visualisation systems. Build it together with its first user (the architecture
explorer) so its shape comes from real needs.

```
                 PROJECT MODEL
                      |
          +-----------+-----------+
          |           |           |
         AST         LSP         Git
          |           |           |
          +-----------+-----------+
                      |
                GRAPH ENGINE
                      |
          +-----------+-----------+
          |           |           |
     Architecture  Runtime    Data Flow
        Graph       Graph       Graph
          |           |           |
          +-----------+-----------+
                      |
                EDITOR ACTIONS
```

This avoids building separate systems that each try to understand the project on their own.
