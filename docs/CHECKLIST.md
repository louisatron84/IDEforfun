# What this IDE needs to do

The roadmap. Work through it roughly top to bottom; each tier builds on the one above.

## Tier 1: core (it's an editor)
- [x] Open a folder, show the file tree, expand/collapse folders (v0.1)
- [x] Open a file and render its text with line numbers in a monospace font (v0.1, read-only)
- [ ] Text buffer model: insert, delete, line/column ↔ offset
- [ ] Cursor: arrows, Home/End, PgUp/PgDn, click to place
- [ ] Typing, Backspace/Delete, Enter (with Python auto-indent after `:`)
- [ ] Selection (shift+arrows, mouse drag), copy/cut/paste
- [ ] Save (Ctrl+S), dirty marker, warning about unsaved changes on close
- [ ] Undo/redo
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
