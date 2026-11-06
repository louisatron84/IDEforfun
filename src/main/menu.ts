/**
 * The app's menu bar. Every item runs the same command as its shortcut in
 * the window (src/renderer/keymap.ts), so the menu and the keyboard can't
 * disagree. Shortcuts are shown next to items but not registered here
 * (registerAccelerator: false): the window handles the keys itself, so
 * nothing fires twice and stock shortcuts like Ctrl+W can't close the window.
 */
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { toAccelerator } from '../shared/keybindings'

/** Edit actions: the window decides whether they go to our editor or to a text box. */
export type EditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface MenuState {
  /** The shortcut shown for each command id (after your changes); null = none. */
  keys: Record<string, string | null>
  /** Recently opened folders, newest first. */
  recent: string[]
}

export function buildMenu(state: MenuState = { keys: {}, recent: [] }): Menu {
  const send = (channel: string, ...args: unknown[]) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    win?.webContents.send(channel, ...args)
  }
  const cmd = (label: string, id: string, fallback?: string): MenuItemConstructorOptions => ({
    label,
    // The renderer tells us each command's current shortcut (you can change them).
    accelerator: id in state.keys ? (state.keys[id] ? toAccelerator(state.keys[id]!) : undefined) : fallback,
    registerAccelerator: false,
    click: () => send('menu:command', id)
  })
  const edit = (label: string, action: EditAction, accelerator: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send('menu:edit', action)
  })
  const sep: MenuItemConstructorOptions = { type: 'separator' }

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        cmd('New File…', 'file.new', 'CmdOrCtrl+N'),
        cmd('New Folder…', 'file.newFolder'),
        sep,
        cmd('Open Folder…', 'file.openFolder', 'CmdOrCtrl+O'),
        cmd('Open Folder by Path…', 'file.openFolderByPath'),
        {
          label: 'Open Recent',
          submenu: state.recent.length
            ? [
                ...state.recent.map((folder): MenuItemConstructorOptions => ({
                  // & would be read as a mnemonic marker on Windows/Linux.
                  label: folder.replace(/&/g, '&&'),
                  click: () => send('menu:openRecent', folder)
                })),
                sep,
                cmd('More…', 'file.openRecent'),
                cmd('Clear Recent Folders', 'file.clearRecent')
              ]
            : [{ label: 'No recent folders', enabled: false }]
        },
        sep,
        cmd('Save', 'file.save', 'CmdOrCtrl+S'),
        cmd('Save with Encoding…', 'file.saveEncoding'),
        cmd('Change Line Endings…', 'file.lineEndings'),
        sep,
        cmd('Rename File…', 'file.rename'),
        cmd('Delete File', 'file.delete'),
        sep,
        cmd('Close Tab', 'tab.close', 'CmdOrCtrl+W'),
        sep,
        {
          label: 'Preferences',
          submenu: [
            cmd('Settings', 'settings.open', 'CmdOrCtrl+,'),
            cmd('Project Settings', 'settings.project'),
            sep,
            cmd('Keyboard Shortcuts…', 'keys.show'),
            cmd('Edit Keyboard Shortcuts File', 'keys.openFile')
          ]
        },
        sep,
        { label: 'Exit', role: 'quit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        edit('Undo', 'undo', 'CmdOrCtrl+Z'),
        edit('Redo', 'redo', 'CmdOrCtrl+Y'),
        sep,
        edit('Cut', 'cut', 'CmdOrCtrl+X'),
        edit('Copy', 'copy', 'CmdOrCtrl+C'),
        edit('Paste', 'paste', 'CmdOrCtrl+V'),
        edit('Select All', 'selectAll', 'CmdOrCtrl+A'),
        sep,
        cmd('Find', 'find.open', 'CmdOrCtrl+F'),
        cmd('Replace', 'find.replace', 'CmdOrCtrl+H'),
        cmd('Search in Project', 'search.project', 'CmdOrCtrl+Shift+F'),
        sep,
        cmd('Toggle Comment', 'editor.toggleComment', 'CmdOrCtrl+/'),
        sep,
        cmd('Quick Fix…', 'editor.quickFix', 'CmdOrCtrl+.'),
        cmd('Format Document', 'editor.format', 'Shift+Alt+F'),
        cmd('Format Selection', 'editor.formatSelection'),
        cmd('Organize Imports', 'editor.organizeImports', 'Shift+Alt+O'),
        cmd('Fix All Auto-fixable Problems', 'editor.fixAll'),
        sep,
        cmd('Fold All', 'editor.foldAll'),
        cmd('Unfold All', 'editor.unfoldAll')
      ]
    },
    {
      label: '&View',
      submenu: [
        cmd('Command Palette…', 'palette.commands', 'CmdOrCtrl+Shift+P'),
        cmd('Go to File…', 'palette.files', 'CmdOrCtrl+P'),
        cmd('Go to Line…', 'palette.line', 'CmdOrCtrl+G'),
        cmd('Go to Definition', 'nav.definition', 'F12'),
        cmd('Find All References', 'nav.references', 'Shift+F12'),
        cmd('Go to Symbol in File…', 'nav.symbol', 'CmdOrCtrl+Shift+O'),
        cmd('Go to Symbol in Project…', 'nav.projectSymbol', 'CmdOrCtrl+T'),
        cmd('Go to Type Definition', 'nav.typeDefinition'),
        cmd('Go to Implementations', 'nav.implementations', 'CmdOrCtrl+F12'),
        cmd('Show Call Hierarchy', 'nav.callHierarchy', 'Shift+Alt+H'),
        cmd('Rename Symbol…', 'editor.renameSymbol', 'F2'),
        cmd('Go Back', 'nav.back', 'Alt+Left'),
        sep,
        cmd('Files', 'view.files', 'CmdOrCtrl+Shift+E'),
        cmd('Outline', 'view.outline'),
        cmd('Project Graph', 'view.projectGraph', 'CmdOrCtrl+Alt+G'),
        { type: 'separator' },
        cmd('Code', 'task.code', 'CmdOrCtrl+Alt+1'),
        cmd('Connect', 'task.connect', 'CmdOrCtrl+Alt+2'),
        cmd('Debug', 'task.debug', 'CmdOrCtrl+Alt+3'),
        cmd('Run', 'task.run', 'CmdOrCtrl+Alt+4'),
        cmd('Edit Layout', 'view.editLayout'),
        cmd('Reset Layout of This Task', 'view.resetLayout'),
        cmd('References', 'panel.references'),
        cmd('Problems', 'panel.problems', 'CmdOrCtrl+Shift+M'),
        cmd('Output', 'panel.output'),
        cmd('Debug Panel', 'panel.debug'),
        cmd('Toggle Bottom Panel', 'panel.toggle', 'CmdOrCtrl+J'),
        sep,
        cmd('Split Editor', 'view.split', 'CmdOrCtrl+\\'),
        cmd('Move Tab to the Other Side', 'view.moveToOtherGroup'),
        cmd('Toggle Minimap', 'editor.toggleMinimap'),
        sep,
        cmd('Bigger Font', 'view.zoomIn', 'CmdOrCtrl+='),
        cmd('Smaller Font', 'view.zoomOut', 'CmdOrCtrl+-'),
        cmd('Toggle Plain Theme', 'view.toggleTheme'),
        sep,
        { label: 'Toggle Developer Tools', role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Run',
      submenu: [
        cmd('Run / Continue', 'run.smart', 'F5'),
        cmd('Run Without Debugging', 'run.file', 'CmdOrCtrl+F5'),
        cmd('Start Debugging', 'debug.start'),
        cmd('Stop', 'run.stop', 'Shift+F5'),
        sep,
        cmd('Select Run Configuration…', 'run.selectConfig'),
        cmd('Edit Run Configurations…', 'run.editConfigs'),
        sep,
        cmd('Run Task…', 'tasks.run', 'CmdOrCtrl+Shift+B'),
        cmd('Run Last Task Again', 'tasks.rerun'),
        sep,
        {
          label: 'Tests',
          submenu: [
            cmd('Show Tests', 'tests.show'),
            cmd('Run All Tests', 'tests.runAll'),
            cmd('Run Failed Tests Again', 'tests.runFailed'),
            cmd('Run Tests in This File', 'tests.runFile'),
            cmd('Run Test at Cursor', 'tests.runAtCursor'),
            cmd('Stop Tests', 'tests.stop')
          ]
        },
        sep,
        cmd('Select Python Interpreter…', 'python.selectInterpreter'),
        cmd('Create Virtual Environment (.venv)…', 'python.createVenv'),
        cmd('Python Packages…', 'python.packages'),
        cmd('Check Dependencies', 'python.checkDeps'),
        cmd('Restart Debugging', 'debug.restart', 'CmdOrCtrl+Shift+F5'),
        sep,
        cmd('Step Over', 'debug.stepOver', 'F10'),
        cmd('Step Into', 'debug.stepInto', 'F11'),
        cmd('Step Out', 'debug.stepOut', 'Shift+F11'),
        sep,
        cmd('Toggle Breakpoint', 'debug.toggleBreakpoint', 'F9'),
        cmd('Edit Breakpoint…', 'debug.editBreakpoint'),
        cmd('Pause on Raised Exceptions', 'debug.toggleRaised'),
        cmd('Remove All Breakpoints', 'debug.clearBreakpoints')
      ]
    },
    {
      label: '&Git',
      submenu: [
        cmd('Source Control', 'git.show', 'CmdOrCtrl+Shift+G'),
        cmd('Show Changes in This File', 'git.diffFile'),
        cmd('History', 'git.history'),
        cmd('File History', 'git.fileHistory'),
        cmd('Toggle Blame', 'git.toggleBlame'),
        sep,
        cmd('Commit', 'git.commit'),
        cmd('Stage All Changes', 'git.stageAll'),
        sep,
        cmd('Switch Branch…', 'git.branch'),
        cmd('Fetch', 'git.fetch'),
        cmd('Pull', 'git.pull'),
        cmd('Push', 'git.push'),
        sep,
        cmd('Initialize Repository', 'git.init')
      ]
    },
    {
      label: '&Terminal',
      submenu: [
        cmd('New Terminal', 'terminal.new', 'CmdOrCtrl+Shift+`'),
        cmd('New Terminal with Shell…', 'terminal.newWithShell'),
        cmd('Toggle Terminal', 'terminal.toggle', 'CmdOrCtrl+`'),
        cmd('Kill Terminal', 'terminal.kill')
      ]
    },
    {
      label: '&Help',
      submenu: [
        cmd('Welcome', 'help.welcome'),
        cmd('All Commands and Shortcuts', 'palette.commands', 'CmdOrCtrl+Shift+P'),
        {
          label: 'About Forge',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            const opts = {
              type: 'info' as const,
              title: 'About Forge',
              message: `Forge ${app.getVersion()}`,
              detail: `A hobby IDE for Python, with a hand-written editor.\n\nElectron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`
            }
            void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
          }
        }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
