/**
 * Creating, renaming and deleting files/folders from the file tree.
 * Names are checked here (not only in the UI) so nothing odd reaches the disk.
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { nameProblem } from '../shared/names'

export { nameProblem }

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Create an empty file or a folder named `name` inside `dir`. Returns its full path. */
export async function createEntry(dir: string, name: string, isDirectory: boolean): Promise<string> {
  const problem = nameProblem(name)
  if (problem) throw new Error(problem)
  const target = join(dir, ...name.split(/[\\/]/))
  if (await exists(target)) throw new Error(`"${name}" already exists.`)
  if (isDirectory) {
    await mkdir(target, { recursive: true })
  } else {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, '', { flag: 'wx' }) // wx: never overwrite
  }
  return target
}

/** Rename a file or folder in place (same parent). Returns the new full path. */
export async function renameEntry(path: string, newName: string): Promise<string> {
  const problem = nameProblem(newName, false)
  if (problem) throw new Error(problem)
  const target = join(dirname(path), newName)
  if (target === path) return path
  // On Windows "a.py" → "A.py" is the same file: allowed, it only changes the case.
  const caseOnly = sep === '\\' && target.toLowerCase() === path.toLowerCase()
  if (!caseOnly && (await exists(target))) throw new Error(`"${newName}" already exists.`)
  await rename(path, target)
  return target
}
