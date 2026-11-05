# What this IDE needs to do

The roadmap. Work through it roughly top to bottom; each tier builds on the one above.

## Tier 1: core (it's an editor)
- [x] Open a folder, show the file tree, expand/collapse folders (v0.1)
- [x] Open a file and render its text with line numbers in a monospace font (v0.1, read-only)
- [x] Text buffer model: insert, delete, line/column ↔ offset
- [x] Cursor: arrows, Home/End, PgUp/PgDn, click to place
- [x] Typing, Backspace/Delete, Enter (with Python auto-indent after `:`)
- [x] Selection (shift+arrows, mouse drag, double/triple-click, Ctrl+A), copy/cut/paste, Tab/Shift+Tab indent (v0.4)
- [x] Save (Ctrl+S), dirty marker, warning about unsaved changes on close (v0.2)
- [x] Undo/redo (v0.3)
- [x] Scrolling that only renders the visible lines (so big files stay fast) (v0.5: 50k lines opens in ~80ms)

## Tier 2: it's an IDE
- [x] Tabs for several open files (v0.6)
- [x] Python syntax highlighting (our own tokenizer) (v0.5)
- [x] Find/replace in the file (v0.7: case, whole word, regex with $1 groups)
- [x] Run the current Python file and show its output in a panel (v0.8: F5, auto-save, venv detection, input(), clickable tracebacks)
- [x] Integrated terminal (xterm.js + node-pty, the one part we don't write ourselves) (v0.9: Ctrl+`)
- [x] Command palette (Ctrl+Shift+P) (v0.11: + Ctrl+P quick open files, Ctrl+G go to line)
- [x] Settings (font size, theme, tab width) (v0.10: + light theme, Python interpreter, Ctrl+= / Ctrl+-)

## Tier 3: smart features
- [ ] Language Server Protocol client (Pyright): errors ✓ (v0.13), autocomplete ✓ (v0.14), go-to-definition, hover
- [x] Search across the project (v0.12: Ctrl+Shift+F, case / word / regex)
- [x] Git status in the file tree (v0.12: M/U/A/D badges, folder dots, auto-refresh)
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
