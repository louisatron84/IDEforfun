// Runs vitest from the project folder's real on-disk path.
//
// On Windows a terminal can report the folder as "c:\..." instead of "C:\...".
// Vitest then ends up loaded twice (once per spelling) and every test file
// fails with "Cannot read properties of undefined (reading 'config')".
// Starting it from the canonical path avoids that.
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const cwd = realpathSync.native(process.cwd())
const cli = join(cwd, 'node_modules', 'vitest', 'vitest.mjs')
const result = spawnSync(process.execPath, [cli, 'run', ...process.argv.slice(2)], { cwd, stdio: 'inherit' })
process.exit(result.status ?? 1)
