# IDEforfun
a ide cus why not

A hobby IDE built with Electron + TypeScript. The text editor is written from scratch. The main target language is Python.

See [docs/CHECKLIST.md](docs/CHECKLIST.md) for the roadmap.

## Run it
```sh
npm install
npm run dev        # launch the app with hot reload
npm test           # unit tests (vitest)
npm run typecheck  # type-check main/preload and renderer
```

## Layout
- `src/main/`: Electron main process (window, file system access over IPC)
- `src/preload/`: the safe bridge that exposes `window.api` to the UI
- `src/shared/`: types shared by both sides
- `src/renderer/`: the UI: file tree and our own editor (`editor/`)
