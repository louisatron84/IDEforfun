/**
 * The Python language server: basedpyright (Pyright with semantic
 * highlighting). Everything Python-specific about talking to it. It reads
 * its analysis settings from `basedpyright.analysis` (plain Pyright from
 * `python.analysis`): both are answered the same.
 */
import type { ServerConfig } from './server'

export const pyright: ServerConfig = {
  id: 'pyright',
  name: 'basedpyright',
  /** `settings.pythonPath`: the interpreter whose installed packages it should see. */
  configuration(section, settings) {
    if (section === 'python') return typeof settings['pythonPath'] === 'string' ? { pythonPath: settings['pythonPath'] } : {}
    if (section === 'python.analysis' || section === 'basedpyright.analysis') {
      // 'standard' checks like Pyright does (basedpyright's own default reports far more).
      return { diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, typeCheckingMode: 'standard' }
    }
    if (section === 'basedpyright') return { disableLanguageServices: false }
    return {}
  }
}
