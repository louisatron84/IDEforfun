/** Pyright: the Python language server. Everything Python-specific about talking to it. */
import type { ServerConfig } from './server'

export const pyright: ServerConfig = {
  id: 'pyright',
  name: 'Pyright',
  /** `settings.pythonPath`: the interpreter whose installed packages it should see. */
  configuration(section, settings) {
    if (section === 'python') return typeof settings['pythonPath'] === 'string' ? { pythonPath: settings['pythonPath'] } : {}
    if (section === 'python.analysis') {
      return { diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, typeCheckingMode: 'standard' }
    }
    return {}
  }
}
