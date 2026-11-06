import { describe, expect, it } from 'vitest'
import { guessPipeline, moveFromImport } from './pipelineView'

describe('Pipeline view helpers', () => {
  it('moveFromImport takes one name out of an import line (and the line if it was the only one)', () => {
    expect(moveFromImport('from forge_blocks import read_csv, merge\nx = 1\n', 'forge_blocks', 'merge')).toBe('from forge_blocks import read_csv\nx = 1\n')
    expect(moveFromImport('from forge_blocks import merge\nx = 1\n', 'forge_blocks', 'merge')).toBe('x = 1\n')
  })
  it('guessPipeline: a pipeline-like name, else the last function of a file using blocks, else the first', () => {
    expect(guessPipeline('', ['load', 'sales_pipeline', 'save'])).toBe('sales_pipeline')
    expect(guessPipeline('from forge_blocks import read_csv', ['helper', 'main'])).toBe('main')
    expect(guessPipeline('', ['a', 'A.m'])).toBe('a')
    expect(guessPipeline('', [])).toBeNull()
  })
})
