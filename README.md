# IDEforfun
a ide cus why not

A hobby IDE built with Electron + TypeScript. The text editor (buffer, cursor, selection, undo, syntax highlighting, rendering) is written from scratch. The main target language is Python.

See [docs/CHECKLIST.md](docs/CHECKLIST.md) for the roadmap.

## Run it
```sh
npm install
npm run dev        # launch the app with hot reload
npm test           # unit tests (vitest)
npm run typecheck  # type-check main/preload and renderer
```

If the app crashes on launch with `Cannot read properties of undefined (reading 'handle')`,
your terminal has `ELECTRON_RUN_AS_NODE` set. Clear it first: `$env:ELECTRON_RUN_AS_NODE=$null` (PowerShell).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+P | Command palette (every command is listed here) |
| Ctrl+P | Go to file |
| Ctrl+G | Go to line |
| Ctrl+O | Open folder |
| Ctrl+N | New file (type `pkg/app.py` to make folders too); right-click the tree for New Folder / Rename / Delete |
| F2 / Delete (in the file tree) | Rename / delete (to the Recycle Bin) |
| Ctrl+S | Save |
| Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab | Close tab / next tab / previous tab |
| Ctrl+F / Ctrl+H | Find / find and replace (Alt+C case, Alt+W word, Alt+R regex) |
| Ctrl+Shift+F / Ctrl+Shift+E | Search the whole project / back to the file tree |
| Ctrl+Space | Autocomplete (also pops up as you type) |
| F12 or Ctrl+click / Alt+← | Go to definition / go back |
| Ctrl+Shift+M | Problems (errors and warnings from Pyright) |
| F5 | Run the current Python file (auto-saves). With breakpoints set it debugs instead; while paused it continues |
| Ctrl+F5 / Shift+F5 | Run without debugging / stop (running or debugging) |
| F9 or click a line number | Toggle a breakpoint |
| F10 / F11 / Shift+F11 | Debugger: step over / step into / step out |
| Ctrl+Shift+F5 | Restart debugging |
| Ctrl+` | Toggle terminal |
| Ctrl+J | Toggle bottom panel |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- | Bigger / smaller code font |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Tab / Shift+Tab | Indent / dedent (all selected lines) |
| Ctrl+C / Ctrl+X (nothing selected) | Copy / cut the whole line |
| Double / triple click | Select word / line |
| Alt+click / Ctrl+Alt+↑ ↓ | Add a cursor there / on the line above or below |
| Ctrl+D / Ctrl+Shift+L | Select the next match too / select every match (multi-cursor) |
| Escape | Back to one cursor |
| Ctrl+/ | Comment / uncomment the selected lines |
| Ctrl+Shift+\ | Jump to the matching bracket |

## Layout
- `src/main/`: Electron main process: file system, running Python (`python.ts`), terminals (`terminals.ts`), settings
- `src/preload/`: the safe bridge that exposes `window.api` to the UI
- `src/shared/`: types and pure helpers shared by both sides (settings, traceback links)
- `src/renderer/`: the UI
  - `editor/`: our own editor: `textBuffer`, `commands`, `selection`, `history` (undo), `tokenizer` + `highlighter` (Python colors), `find`, `document`, `editor` (rendering + input)
  - `workspace.ts` + `tabBar.ts`: open files and tabs
  - `keymap.ts`: every command and shortcut, registered once (the palette lists them)
  - `findBar.ts`, `panel.ts`, `outputView.ts`, `terminalView.ts`, `settingsView.ts`, `palette.ts`, `fuzzy.ts`
- `styles.css`: all colors are CSS variables (dark + light themes), ready for a redesign

## Third-party code
Everything above is hand-written except three pieces: the integrated terminal uses
[xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty), and Python intelligence
(errors, autocomplete, hover, go to definition) comes from the [Pyright](https://github.com/microsoft/pyright) language server, and the debugger is
[debugpy](https://github.com/microsoft/debugpy) (installed into your Python on first use).
The protocol clients talking to them are hand-written (`src/renderer/lsp/`, `src/renderer/debug/`).
