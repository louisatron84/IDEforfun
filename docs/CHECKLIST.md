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
- [ ] Multiple editor groups / split view
- [ ] File encoding detection and conversion
- [ ] CRLF/LF line endings: show and convert (files already keep their own line endings when saved)
- [ ] Large-file mode and graceful handling of binary files
- [ ] Recovery of unsaved buffers after unexpected crashes

## Tier 2: IDE foundations

- [x] Tabs for several open files (v0.6)
- [x] Python syntax highlighting (own tokenizer, v0.5)
- [x] Find/replace in the file (case, whole word, regex with $1 groups, v0.7)
- [x] Run the current Python file and show its output in a panel (F5, auto-save, venv detection, `input()`, clickable tracebacks, v0.8)
- [x] Integrated terminal (xterm.js + node-pty, Ctrl+`, v0.9)
- [x] Command palette (Ctrl+Shift+P), quick open (Ctrl+P), go to line (Ctrl+G) (v0.11)
- [x] Settings (font size, theme, tab width, Python interpreter, Ctrl+= / Ctrl+-) (v0.10)
- [ ] Multiple terminal sessions
- [ ] Terminal profiles and shell selection
- [ ] Configurable keyboard shortcuts
- [ ] Recent projects
- [ ] Workspace persistence (restore tabs, terminal sessions and layout)
- [ ] Project-specific settings
- [ ] Task runner for predefined project commands
- [ ] Run configurations (arguments, environment variables and working directory)
- [ ] Python environment management (create, select and manage virtual environments)
- [ ] Dependency management integration (pip, requirements.txt, pyproject.toml)
- [ ] Test runner integration (pytest, unittest)
  - [ ] Test discovery and running individual tests
  - [ ] Test results panel with navigation to failures

## Tier 3: Intelligence and developer tooling

- [x] Language Server Protocol client (Pyright)
  - [x] Diagnostics and errors (v0.13)
  - [x] Autocomplete (v0.14)
  - [x] Hover information and go-to-definition (v0.15)
- [x] Search across the project (Ctrl+Shift+F, case / word / regex, v0.12)
- [x] Git status in the file tree (M/U/A/D badges, folder dots, auto-refresh, v0.12)
- [x] Debugger (DAP, debugpy): breakpoints, stepping, call stack, variables, debug console with expression evaluation, hover values, pause on uncaught exceptions (v0.17)

Language features (Pyright already does the analysis for most of these; they're mostly UI work):
- [ ] Find references
- [ ] Rename symbol across project
- [ ] Go to implementation
- [ ] Call hierarchy
- [ ] Document symbols / outline panel
- [ ] Import organisation and automatic import suggestions
- [ ] Code actions and quick fixes
- [ ] Format document / selection (Black, Ruff)
- [ ] Linting integration (Ruff)
- [ ] Semantic syntax highlighting
- [ ] Language-support architecture: language integrations instead of Python-specific editor logic, so several language servers can run side by side (groundwork for Tier 6.2)

Git:
- [ ] Git diff viewer
- [ ] Stage/unstage individual hunks
- [ ] Commit interface
- [ ] Branch switching and creation
- [ ] Merge conflict resolution
- [ ] Git history and file blame, with a graph view

Debugger improvements:
- [ ] Support `input()` while debugging (run the debugged program in a terminal)
- [ ] Conditional breakpoints
- [ ] Watch expressions
- [ ] Option to pause on every raised exception, not just uncaught ones
- [ ] Breakpoint management panel (and keep breakpoints between sessions)
- [ ] Debug multiple processes

## Tier 4: Visual identity and workspace

Goal: give the IDE a distinctive identity rather than reskinning a conventional editor layout.
Best started once a first graph view exists (5.1), so the layout is designed around real visual tools.

- [ ] Design a distinctive workspace layout
- [ ] Rethink how files, terminals, graphs and debugging coexist
- [ ] Customisable workspace panels
- [ ] Dockable panels and floating windows
- [ ] Multiple workspace layouts (coding, debugging and visualisation)
- [ ] Context-aware interface that surfaces relevant tools for the current task
- [ ] Customisable information density
- [ ] Animated transitions between workspace states
- [ ] Visual navigation through projects
- [ ] Consistent visual language for graphs, code, debugging and terminal

## Tier 5: Visual programming environment

Visualisations are interactive representations of real code, not a separate programming system.

### 5.1 Project intelligence graph
- [ ] Parse the project using Python's `ast` (a helper script run with the project's own Python)
- [ ] Build a project dependency graph: files, modules, classes, functions, imports
- [ ] Function-to-function call relationships
- [ ] Detect API endpoints called (`requests`, `httpx`, `aiohttp`)
- [ ] Detect API routes (FastAPI, Flask)
- [ ] Detect environment variables
- [ ] Display dependencies between components
- [ ] Click a graph node to navigate to its source code
- [ ] Highlight a node's dependencies and dependants
- [ ] Filter graph by type, file or relationship
- [ ] Detect circular imports
- [ ] Identify unused functions and potentially unreachable code where statically determinable

### 5.2 Live network visualisation
- [ ] Runtime instrumentation for `requests`, `httpx` and `aiohttp`
- [ ] Capture socket-level connections where appropriate
- [ ] Stream runtime events to the IDE
- [ ] Animated network graph
- [ ] Display HTTP method, URL, status and response time
- [ ] Click a connection to inspect request/response details
- [ ] Request history and filtering
- [ ] Group requests by host and originating function
- [ ] Identify failed requests and slow endpoints
- [ ] Timeline showing when requests occurred
- [ ] Compare network activity between runs

### 5.3 Visual API integration
- [ ] Drag from a file/function to an unconnected API
- [ ] Generate client modules and imports
- [ ] Generate `.env` keys
- [ ] OpenAPI / Swagger support
  - [ ] Generate functions for individual endpoints
  - [ ] Generate request and response models
  - [ ] Generate authentication handling
- [ ] Support APIs without specifications
  - [ ] Generate base URL configuration
  - [ ] Generate authentication configuration
  - [ ] Generate an example request
- [ ] Preview generated code before applying changes
- [ ] Ensure visual changes generate normal, readable Python
- [ ] When removing a visual connection, offer to remove associated code
- [ ] Detect changes to generated code and update graph relationships
- [ ] Later: AI-assisted API documentation interpretation and integration

### 5.4 Data-flow visualisation
- [ ] Trace data between functions
- [ ] Visualise function inputs and outputs
- [ ] Show where variables originate
- [ ] Show transformations applied to data
- [ ] Highlight data dependencies
- [ ] Interactive pipeline graph
- [ ] Pandas DataFrame pipeline visualisation
- [ ] Inspect DataFrame shapes, columns and types
- [ ] Preview intermediate DataFrame contents
- [ ] Visualise data filtering, grouping and merging
- [ ] Export visual pipelines as ordinary Python

### 5.5 Execution visualisation
- [ ] Live call graph while debugging
- [ ] Animated function execution
- [ ] Visualise recursion trees
- [ ] Show current execution position on the graph
- [ ] Display live variable values on nodes
- [ ] Track variable changes over time
- [ ] Visualise object relationships
- [ ] Inspect object properties without opening debugger panels
- [ ] Compare variable states between execution points
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
- [ ] Project templates and custom scaffolding
- [ ] Build-system integration
- [ ] Docker integration
- [ ] Remote development over SSH
- [ ] Container-based development environments
- [ ] Background task execution
- [ ] Automated project health checks

## Additional feature ideas

Optional directions that could extend the IDE beyond the core roadmap.

**Architecture explorer**
- [ ] Automatically reconstruct the architecture of an unfamiliar codebase
- [ ] Show components, dependencies, entry points and communication paths
- [ ] Provide a visual map of how the project works

**Visual profiler**
- [ ] Show execution time directly on the project graph
- [ ] Highlight expensive functions
- [ ] Display call paths to explain where time is spent

**Database explorer**
- [ ] Detect database connections and ORM models
- [ ] Generate interactive schema diagrams
- [ ] Show database relationships
- [ ] Navigate from schema elements to relevant code

**Event-flow visualiser**
- [ ] Track events through an application: where they originate, which handlers process them, what gets triggered and where they end up
- [ ] Support asynchronous and event-driven applications

**Memory explorer**
- [ ] Visualise object references, memory allocations and object lifetimes
- [ ] Inspect memory usage during execution
- [ ] Identify unexpected object retention

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
