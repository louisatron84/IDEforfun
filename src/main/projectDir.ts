/**
 * Forge keeps a project's own files (settings.json, run.json…) in
 * <project>/.forge. Projects from before the rename have <project>/.ideforfun:
 * that folder is renamed the first time the project is opened, or copied
 * when it can't be renamed (on Windows a file inside it may be locked).
 */
import { cp as fsCp, rename as fsRename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_PROJECT_DIR, PROJECT_DIR } from '../shared/settings'

/** 'error': neither moving nor copying worked; nothing was changed (the old folder is untouched). */
export type ProjectDirResult = 'none' | 'migrated' | 'copied' | 'both' | 'error'

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function prepareProjectDir(
  root: string,
  fsOps: {
    rename?: (from: string, to: string) => Promise<void>
    cp?: (from: string, to: string) => Promise<void>
  } = {}
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
    // Copy into a temporary folder and only then give it the real name, so a copy that
    // fails partway never leaves a half-filled .forge that would win from then on.
    const temp = join(root, `${PROJECT_DIR}-copying-${process.pid}`)
    try {
      await (fsOps.cp ?? ((from, to) => fsCp(from, to, { recursive: true })))(legacy, temp)
      await fsRename(temp, current)
      return 'copied'
    } catch {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
      return 'error'
    }
  }
}
