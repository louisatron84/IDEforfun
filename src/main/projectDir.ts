/**
 * Forge keeps a project's own files (settings.json, run.json…) in
 * <project>/.forge. Projects from before the rename have <project>/.ideforfun:
 * that folder is renamed the first time the project is opened, or copied
 * when it can't be renamed (on Windows a file inside it may be locked).
 */
import { cp, rename as fsRename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_PROJECT_DIR, PROJECT_DIR } from '../shared/settings'

export type ProjectDirResult = 'none' | 'migrated' | 'copied' | 'both'

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function prepareProjectDir(
  root: string,
  fsOps: { rename?: (from: string, to: string) => Promise<void> } = {}
): Promise<ProjectDirResult> {
  const current = join(root, PROJECT_DIR)
  const legacy = join(root, LEGACY_PROJECT_DIR)
  const hasLegacy = await isDir(legacy)
  if (await isDir(current)) return hasLegacy ? 'both' : 'none'
  if (!hasLegacy) return 'none'
  try {
    await (fsOps.rename ?? fsRename)(legacy, current)
    return 'migrated'
  } catch {
    await cp(legacy, current, { recursive: true })
    return 'copied'
  }
}
