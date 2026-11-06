import { describe, expect, it } from 'vitest'
import { hunkPatch, isValidBranchName, parseBranches, parseDiff, parseStatusV2 } from './git'

describe('parseStatusV2', () => {
  it('reads the branch and staged / unstaged / untracked / conflicted files', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb src/app.py',
      '1 .M N... 100644 100644 100644 aaa bbb README.md',
      '1 MM N... 100644 100644 100644 aaa bbb both.py',
      '1 A. N... 000000 100644 100644 000 bbb new file.py',
      '2 R. N... 100644 100644 100644 aaa bbb R100 lib/new.py', 'lib/old.py',
      'u UU N... 100644 100644 100644 100644 a b c clash.py',
      '? notes.txt',
      ''
    ].join('\0')
    const s = parseStatusV2(out)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false, initial: false })
    expect(s.staged).toEqual([
      { path: 'src/app.py', kind: 'modified' },
      { path: 'both.py', kind: 'modified' },
      { path: 'new file.py', kind: 'added' },
      { path: 'lib/new.py', kind: 'renamed', from: 'lib/old.py' }
    ])
    expect(s.unstaged).toEqual([
      { path: 'README.md', kind: 'modified' },
      { path: 'both.py', kind: 'modified' },
      { path: 'notes.txt', kind: 'untracked' }
    ])
    expect(s.conflicts).toEqual([{ path: 'clash.py', kind: 'conflict' }])
  })
  it('knows a detached HEAD and a repo with no commits', () => {
    expect(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0')).toMatchObject({ detached: true, branch: null })
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ initial: true, branch: 'main' })
  })
})

const DIFF = `diff --git a/app.py b/app.py
index 1111111..2222222 100644
--- a/app.py
+++ b/app.py
@@ -1,4 +1,4 @@
 import os
-x = 1
+x = 2
 y = 3
 z = 4
@@ -10,3 +10,4 @@ def main():
     a()
     b()
+    c()
 end
\\ No newline at end of file
diff --git a/new.py b/new.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.py
@@ -0,0 +1 @@
+print("hi")
`

describe('parseDiff', () => {
  it('splits files and hunks with line numbers', () => {
    const files = parseDiff(DIFF)
    expect(files).toHaveLength(2)
    const [app, added] = files
    expect(app).toMatchObject({ oldPath: 'app.py', newPath: 'app.py', binary: false })
    expect(app.hunks).toHaveLength(2)
    expect(app.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      [' ', 1, 1], ['-', 2, null], ['+', null, 2], [' ', 3, 3], [' ', 4, 4]
    ])
    expect(app.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 })
    expect(app.hunks[1].lines[3]).toMatchObject({ text: 'end', noNewline: true })
    expect(added).toMatchObject({ oldPath: null, newPath: 'new.py' })
    expect(added.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 })
  })
  it('notices binary files', () => {
    const f = parseDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n')
    expect(f[0].binary).toBe(true)
  })
})

describe('hunkPatch', () => {
  it('makes a patch of one hunk, keeping the file header', () => {
    const [app] = parseDiff(DIFF)
    expect(hunkPatch(app, app.hunks[1])).toBe([
      'diff --git a/app.py b/app.py', 'index 1111111..2222222 100644', '--- a/app.py', '+++ b/app.py',
      '@@ -10,3 +10,4 @@ def main():', '     a()', '     b()', '+    c()', ' end', '\\ No newline at end of file', ''
    ].join('\n'))
  })
})

describe('branches', () => {
  it('reads local and remote branches', () => {
    const out = ['refs/heads/main\0*\0origin/main', 'refs/heads/feature/x\0 \0', 'refs/remotes/origin/HEAD\0 \0', 'refs/remotes/origin/main\0 \0', ''].join('\n')
    expect(parseBranches(out)).toEqual([
      { name: 'main', current: true, remote: false, upstream: 'origin/main' },
      { name: 'feature/x', current: false, remote: false, upstream: null },
      { name: 'origin/main', current: false, remote: true, upstream: null }
    ])
  })
  it('checks branch names', () => {
    for (const ok of ['main', 'feature/login', 'fix-1.2', 'user/louis/thing']) expect(isValidBranchName(ok)).toBe(true)
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', 'a/', 'a//b', '@', 'a:b', 'what?']) expect(isValidBranchName(bad)).toBe(false)
  })
})
