import { describe, expect, it } from 'vitest'
import { pathToUri, uriToPath } from './uri'

describe('pathToUri / uriToPath', () => {
  it('converts Windows paths, encoding the drive colon and spaces', () => {
    const uri = pathToUri('C:\\Users\\louis\\My Project\\app.py')
    expect(uri).toBe('file:///c%3A/Users/louis/My%20Project/app.py')
    expect(uriToPath(uri)).toBe('C:\\Users\\louis\\My Project\\app.py')
  })
  it('accepts the unencoded drive form some servers send back', () => {
    expect(uriToPath('file:///C:/a/b.py')).toBe('C:\\a\\b.py')
  })
  it('converts POSIX paths', () => {
    expect(pathToUri('/home/me/a b.py')).toBe('file:///home/me/a%20b.py')
    expect(uriToPath('file:///home/me/a%20b.py')).toBe('/home/me/a b.py')
  })
  it('encodes characters that are special in URLs', () => {
    const p = 'C:\\x\\#hash%?.py'
    expect(uriToPath(pathToUri(p))).toBe(p)
  })
})
