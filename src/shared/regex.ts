/**
 * Search options and regex building, shared by in-file find (renderer) and
 * project-wide search (main process) so both behave exactly the same.
 */

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the RegExp for a query, or return an error message for an invalid regex. */
export function buildRegExp(query: string, opts: FindOptions, global = true): RegExp | string {
  let source = opts.regex ? query : escapeRegExp(query)
  if (opts.wholeWord) source = `\\b(?:${source})\\b`
  try {
    return new RegExp(source, (global ? 'g' : '') + (opts.caseSensitive ? '' : 'i'))
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
