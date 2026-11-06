/**
 * The project's .env file on disk: secrets for the API box, and the
 * variables Forge adds to the environment of Run, Tests, Debug and new
 * terminals (the real environment always wins).
 */
import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeEnv, parseDotEnv, setDotEnvVar } from '../shared/dotenv'

export const envPath = (root: string) => join(root, '.env')

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function readDotEnv(root: string): Promise<Record<string, string>> {
  const text = await readText(envPath(root)).catch(() => null)
  return text === null ? {} : parseDotEnv(text)
}

export async function setDotEnvValue(root: string, name: string, value: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" isn't a valid variable name (letters, digits and _).`)
  const text = (await readText(envPath(root))) ?? ''
  await fs.writeFile(envPath(root), setDotEnvVar(text, name, value), 'utf8')
}

/** The variables that have a value (names only: the window never needs the secrets). */
export async function envNames(root: string): Promise<string[]> {
  return Object.entries(await readDotEnv(root)).filter(([, v]) => v !== '').map(([k]) => k)
}

const IGNORES_ENV = new Set(['.env', '/.env', '*.env', '.env*', '/.env*', '**/.env'])

export async function gitignoreHasEnv(root: string): Promise<boolean> {
  const text = await readText(join(root, '.gitignore')).catch(() => null)
  if (!text) return false
  return text.split(/\r?\n/).some((line) => IGNORES_ENV.has(line.trim()))
}

export async function addEnvToGitignore(root: string): Promise<void> {
  const path = join(root, '.gitignore')
  const text = (await readText(path)) ?? ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  await fs.writeFile(path, `${text}${text && !text.endsWith('\n') ? eol : ''}.env${eol}`, 'utf8')
}

/**
 * The environment for a process started for the project: the real
 * environment, plus .env for names it doesn't have (compared without case on
 * Windows, where PATH and Path are the same variable), plus `extra`.
 */
export async function processEnv(root: string | null, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return processEnvSync(root, extra)
}

/** processEnv, for code that starts processes synchronously. */
export function processEnvSync(root: string | null, extra: Record<string, string> = {}): Record<string, string> {
  let dotenv: Record<string, string> = {}
  if (root) {
    try {
      dotenv = parseDotEnv(readFileSync(envPath(root), 'utf8'))
    } catch {
      // no .env (or unreadable): nothing to add
    }
  }
  if (process.platform === 'win32') {
    const have = new Set(Object.keys(process.env).map((k) => k.toUpperCase()))
    dotenv = Object.fromEntries(Object.entries(dotenv).filter(([k]) => !have.has(k.toUpperCase())))
  }
  return { ...mergeEnv(process.env, dotenv), ...extra }
}
