# IDEforfun
a ide cus why not

A hobby IDE built with Electron + TypeScript. The text editor (buffer, cursor, selection, undo, syntax highlighting, rendering) is written from scratch. The main target language is Python.

See [docs/CHECKLIST.md](docs/CHECKLIST.md) for the roadmap.

## Before you install
You need **Node.js 22+** and **Python 3** (for running and debugging your code).

The integrated terminal uses [node-pty](https://github.com/microsoft/node-pty), a native module.
On **Windows** and **macOS** it comes prebuilt, so `npm install` just works. On **Linux** it's compiled
during `npm install`, so you need a C++ toolchain first:

```sh
# Debian / Ubuntu
sudo apt install build-essential python3 make g++
# Fedora
sudo dnf install gcc-c++ make python3
# Arch
sudo pacman -S base-devel python
```

If `npm install` fails with `gyp ERR!` or `node-pty` in the error, this is the missing piece.
On macOS, if it does need building, run `xcode-select --install` first.

Optional: the debugger uses `debugpy` (`pip install debugpy`). The IDE offers to install it the first time you debug.

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
| Ctrl+O / Ctrl+R | Open folder / open a recent folder (also File → Open Recent) |
| Ctrl+N | New file (with no folder open it asks where to save it) (type `pkg/app.py` to make folders too); right-click the tree for New Folder / Rename / Delete |
| F2 / Delete (in the file tree) | Rename / delete (to the Recycle Bin) |
| Ctrl+S | Save |
| Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab | Close tab / next tab / previous tab |
| Ctrl+\ / Ctrl+1 / Ctrl+2 | Split the editor (same file on both sides, own cursors) / focus left / focus right |
| Ctrl+F / Ctrl+H | Find / find and replace (Alt+C case, Alt+W word, Alt+R regex) |
| Ctrl+Shift+F / Ctrl+Shift+E | Search the whole project / back to the file tree |
| Ctrl+Shift+G | Source control (Git tab): changes, diffs, stage, commit (Ctrl+Enter), branches, pull / push |
| Ctrl+Space | Autocomplete (also pops up as you type) |
| F12 or Ctrl+click / Alt+← | Go to definition / go back |
| Shift+F12 | Find all references (References tab in the bottom panel) |
| Ctrl+F12 | Go to implementations: subclasses of a class, or overrides of a method |
| Shift+Alt+H | Call hierarchy: who calls this function / what it calls (Calls tab) |
| Ctrl+T | Go to a class / function anywhere in the project |
| F2 (in the editor) | Rename a symbol everywhere it's used |
| Ctrl+Shift+O | Go to a class / function in this file (also the Outline tab in the sidebar) |
| Ctrl+. (or click 💡) | Quick fixes: Ruff's fixes, Pyright's actions, ignore a rule on this line |
| Shift+Alt+F / Shift+Alt+O | Format the file (Ruff or Black) / organize imports (sort, remove unused) |
| Ctrl+Shift+M | Problems (errors and warnings from Pyright) |
| F5 | Run the current Python file (auto-saves). With breakpoints set it debugs instead; while paused it continues |
| Ctrl+F5 / Shift+F5 | Run without debugging / stop (running or debugging) |
| F9 or click a line number | Toggle a breakpoint |
| F10 / F11 / Shift+F11 | Debugger: step over / step into / step out |
| Ctrl+Shift+F5 | Restart debugging |
| Ctrl+Shift+B | Run a task (in its own terminal) |
| Ctrl+` / Ctrl+Shift+` | Toggle terminal / new terminal (pick a shell with ▾ in the terminal panel) |
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
| Ctrl+Shift+[ / Ctrl+Shift+] | Fold / unfold the block (or click the arrows next to the line numbers) |
| Ctrl+Shift+\\ | Jump to the matching bracket |

Every shortcut can be changed: **File → Preferences → Keyboard Shortcuts…** (or
"Keyboard Shortcuts" in the command palette) lists them all, marks clashes, and lets
you press new keys, remove them or reset them. Changes go in `keybindings.json` in
the app's data folder, which you can also edit by hand ("Edit Keyboard Shortcuts File"):

```json
{ "run.file": "Ctrl+Shift+R", "palette.files": ["Ctrl+P", "Ctrl+E"], "nav.back": null }
```

## Projects
- The **Welcome page** shows when no file is open (and from Help → Welcome): new file or folder,
  open a folder, recent folders, project actions and the main shortcuts. New Folder with no
  folder open makes a new project folder and opens it. Turn it off with the tick box at the bottom.
- The last project reopens at startup with its tabs, split, cursor positions, terminals
  and bottom panel (turn this off in Settings). Each project remembers its own layout.
- A project can override some settings in `.ideforfun/settings.json`
  (File → Preferences → Project Settings):

```json
{ "tabSize": 2, "pythonPath": ".venv/Scripts/python.exe", "shell": "gitbash" }
```

  A relative `pythonPath` is relative to the project folder.
- **🐍 in the status bar** shows the project's Python. Click it to pick another
  interpreter (project venvs, installed Pythons, or a path) or to create a `.venv`;
  the choice is saved in the project settings and used by Run, Debug and error checking.
- **Packages** (Run → Python Packages…): install, upgrade or uninstall packages, install
  from `requirements.txt` or the project's `pyproject.toml`, or save what's installed to
  `requirements.txt`. If the project needs packages that aren't installed, the status
  bar says so (⚠ n missing packages); click it to install them. pip runs in the Output panel.
- **Git** (Git tab, Git menu, ⎇ in the status bar): changed files grouped as conflicts / staged /
  changes; click one for a colored diff where each hunk can be staged, unstaged or discarded
  on its own. Commit (or amend), switch / create branches, fetch, pull and push. Open files
  without unsaved changes reload when a switch or pull changes them.
  Merge conflicts are shaded (yours green, incoming blue) with a bar to accept current /
  incoming / both and then save and mark the file resolved. **History** (bottom panel)
  draws the commit graph; click a commit for its files and diffs; Git → File History for one
  file. Who last changed the cursor's line shows in the status bar; Git → Toggle Blame shows
  it for every line.
- **Ruff and Black**: if Ruff is installed in the project's Python (Quick Fix offers to
  install it), its warnings show as you type next to Pyright's, with 💡 on lines it can fix.
  Format with Ruff or Black (Settings → Formatter, optional format on save); the project's
  own Ruff/Black configuration is used.
- **Tests** (Run → Tests, or the Tests tab in the bottom panel): every test in
  `test_*.py` / `*_test.py`, grouped by file. Run all of them, only the failed ones, a
  file, or one test (▶ on its row, or "Run Test at Cursor"). Failures show their message;
  click to jump to the failing line, ▸ for the full traceback. Uses pytest when it's
  installed (offers to install it), otherwise unittest.
- Run configurations and tasks live in `.ideforfun/run.json` (Run → Edit Run Configurations).
  Click **▶** in the status bar (or Run → Select Run Configuration) to choose what F5 /
  Ctrl+F5 run; "Current file" is the default. Configurations work for debugging too.
  Tasks are shell commands, each run in its own terminal (Ctrl+Shift+B).
  `${file}`, `${fileDir}` and `${project}` can be used anywhere:

```json
{
  "configurations": [
    { "name": "Server", "file": "app/main.py", "args": ["--port", "8000"], "env": { "DEBUG": "1" }, "cwd": "${project}" },
    { "name": "Flask", "module": "flask", "args": "run --debug" }
  ],
  "tasks": [
    { "name": "Install requirements", "command": "python -m pip install -r requirements.txt" },
    { "name": "Lint this file", "command": "ruff check ${file}" }
  ]
}
```

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
