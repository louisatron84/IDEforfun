/**
 * The Python language server: basedpyright (Pyright with semantic
 * highlighting). Everything Python-specific about talking to it.
 *
 * Its analysis settings are asked for under several names (`python.analysis`,
 * `basedpyright.analysis`, or the whole `basedpyright` section with an
 * `analysis` inside): all get the same answer. Checks are Pyright's
 * 'standard' ones: basedpyright's own default warns about every value whose
 * type it can't work out, which is most code written without type hints.
 */
import type { ServerConfig } from './server'

const ANALYSIS = {
  diagnosticMode: 'openFilesOnly',
  autoSearchPaths: true,
  useLibraryCodeForTypes: true,
  typeCheckingMode: 'standard',
  // Belt and braces: never the "unknown type" family for code without type hints.
  diagnosticSeverityOverrides: {
    reportUnknownParameterType: 'none',
    reportUnknownArgumentType: 'none',
    reportUnknownVariableType: 'none',
    reportUnknownMemberType: 'none',
    reportUnknownLambdaType: 'none',
    reportMissingParameterType: 'none',
    reportMissingTypeArgument: 'none',
    reportAny: 'none',
    reportExplicitAny: 'none'
  }
}

export const pyright: ServerConfig = {
  id: 'pyright',
  name: 'basedpyright',
  /** `settings.pythonPath`: the interpreter whose installed packages it should see. */
  configuration(section, settings) {
    const pythonPath = typeof settings['pythonPath'] === 'string' ? { pythonPath: settings['pythonPath'] } : {}
    if (section === 'python') return { ...pythonPath, analysis: ANALYSIS }
    if (section === 'python.analysis' || section === 'basedpyright.analysis') return ANALYSIS
    if (section === 'basedpyright') return { disableLanguageServices: false, analysis: ANALYSIS }
    return {}
  }
}
