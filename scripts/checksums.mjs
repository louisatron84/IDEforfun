// Writes release/SHA256SUMS-windows.txt for the Windows downloads of the
// current version (run after `npm run dist`; attach it to the GitHub release).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const files = [`Forge-Setup-${version}.exe`, `Forge-${version}-portable.exe`]
const lines = files.map((name) => `${createHash('sha256').update(readFileSync(`release/${name}`)).digest('hex')}  ${name}`)
writeFileSync('release/SHA256SUMS-windows.txt', lines.join('\n') + '\n')
console.log(lines.join('\n'))
