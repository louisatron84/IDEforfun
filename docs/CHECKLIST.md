# What this IDE needs to do

The roadmap. Work through it roughly top to bottom; each tier builds on the one above.

## Tier 1: core (it's an editor)
- [x] Open a folder, show the file tree, expand/collapse folders (v0.1)
- [x] Open a file and render its text with line numbers in a monospace font (v0.1, read-only)
- [x] Text buffer model: insert, delete, line/column ↔ offset
- [x] Cursor: arrows, Home/End, PgUp/PgDn, click to place
- [x] Typing, Backspace/Delete, Enter (with Python auto-indent after `:`)
- [ ] Selection (shift+arrows, mouse drag), copy/cut/paste
- [x] Save (Ctrl+S), dirty marker, warning about unsaved changes on close (v0.2)
- [x] Undo/redo (v0.3)
- [ ] Scrolling that only renders the visible lines (so big files stay fast)

## Tier 2: it's an IDE
- [ ] Tabs for several open files
- [ ] Python syntax highlighting (our own tokenizer)
- [ ] Find/replace in the file
- [ ] Run the current Python file and show its output in a panel
- [ ] Integrated terminal (xterm.js + node-pty, the one part we don't write ourselves)
- [ ] Command palette (Ctrl+Shift+P)
- [ ] Settings (font size, theme, tab width)

## Tier 3: smart features
- [ ] Language Server Protocol client (pyright/pylsp): errors, autocomplete, go-to-definition, hover
- [ ] Search across the project
- [ ] Git status in the file tree
- [ ] Debugger (DAP, debugpy)
- 

## Later: own visual identity
- [ ] Redesign so it doesn't look like every other IDE (the current dark sidebar + tabs layout is a placeholder)

## Tier 4: visual tools (the thing that makes this IDE different)
Rule: **the code is the source of truth**. Graphs are views of the code plus a way to edit it, and anything done in a graph turns into normal, readable Python.
- [ ] Project graph from code scanning (Python `ast`): files → functions → API endpoints called (`requests`/`httpx`/`aiohttp`), FastAPI/Flask routes, env vars
- [ ] Live network view: "Run" loads a small hook that wraps `requests`/`httpx`/`socket` and streams each call (method, URL, status, timing) to the IDE as an animated graph/timeline (needs Tier 2 "Run current file")
- [ ] Drag to connect APIs: drag a line from a file to an unconnected API, and the IDE generates the client module, `.env` key, and import
  - [ ] APIs with an OpenAPI/Swagger spec: generate a real function per endpoint
  - [ ] APIs without a spec: generate a skeleton (base URL, auth, one example request)
  - [ ] Later: AI help reads API docs and writes glue code between APIs
- [ ] More visuals: call graph, live variable values, data flowing through pandas pipelines, import map, recursion trees
