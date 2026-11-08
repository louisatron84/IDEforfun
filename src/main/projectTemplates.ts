/**
 * Project templates on disk: making a project from one, and your own
 * templates (Save Project as Template…), kept in <userData>/templates/<id>/
 * with a template.json ({ name, detail }) beside the files.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { moduleName, projectNameProblem, safeTemplatePath, type ProjectTemplate, type TemplateFile } from '../shared/templates'

const MAX_FILES = 300
const MAX_FILE_BYTES = 512 * 1024
/** Never copied into a template: environments, caches, history, and secrets (.env). */
const SKIP = new Set(['.git', '.hg', '.svn', '.venv', 'venv', 'env', '__pycache__', 'node_modules', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'build', 'dist', '.idea', '.vscode', '.env', '.DS_Store'])

const exists = (p: string) => stat(p).then(() => true, () => false)

/** Make `<parent>/<name>` with the files (it must not exist yet). Returns its path. */
export async function createProject(parent: string, name: string, files: readonly TemplateFile[]): Promise<string> {
  const problem = projectNameProblem(name)
  if (problem) throw new Error(problem)
  const target = join(parent, name.trim())
  if (await exists(target)) throw new Error(`"${name.trim()}" already exists in ${parent}.`)
  for (const f of files) if (!safeTemplatePath(f.path)) throw new Error(`The template has a file Forge won't write: ${f.path}`)
  await mkdir(target, { recursive: true })
  for (const f of files) {
    const path = join(target, ...f.path.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, f.content, { encoding: 'utf8', flag: 'wx' })
  }
  return target
}

/** Text files of a folder (skipping environments, caches and secrets), relative paths with /. */
async function textFiles(root: string): Promise<TemplateFile[]> {
  const out: TemplateFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return
      if (SKIP.has(e.name) || e.name.endsWith('.egg-info') || e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (await exists(join(full, 'pyvenv.cfg'))) continue
        await walk(full)
      } else if (e.isFile()) {
        if ((await stat(full)).size > MAX_FILE_BYTES) continue
        const bytes = await readFile(full)
        if (bytes.includes(0)) continue // binary
        out.push({ path: relative(root, full).split(sep).join('/'), content: bytes.toString('utf8') })
      }
    }
  }
  await walk(root)
  return out
}

/**
 * Save the project as a template: its text files, with the project's name
 * (and its Python name) turned into {{name}} / {{module}} so a new project
 * gets its own. Returns the template's id.
 */
export async function saveTemplate(root: string, templatesDir: string, name: string, detail = ''): Promise<string> {
  const title = name.trim()
  if (!title) throw new Error('Type a name for the template.')
  const project = basename(root)
  const mod = moduleName(project)
  // A folder already named like Python code (weather_bot) stands for the new project's Python name, so
  // its files stay importable; any other name (Weather Bot) stands for the name as typed.
  // Not inside a longer name ("weather_bots"), but "_" may join it to others ("test_weather_bot").
  const modRe = new RegExp(`(?<![A-Za-z0-9])${mod}(?![A-Za-z0-9])`, 'g')
  const swap = (s: string) => {
    let t = s
    if (mod === project) return mod.length >= 3 ? t.replace(modRe, '{{module}}') : t
    if (project.length >= 3) t = t.split(project).join('{{name}}')
    if (mod.length >= 3) t = t.replace(modRe, '{{module}}')
    return t
  }
  const files = (await textFiles(root)).map((f) => ({ path: swap(f.path), content: swap(f.content) }))
  if (!files.length) throw new Error('The project has no text files to save.')
  let id = moduleName(title)
  for (let n = 2; await exists(join(templatesDir, id)); n++) id = `${moduleName(title)}_${n}`
  const dir = join(templatesDir, id)
  for (const f of files) {
    const path = join(dir, 'files', ...f.path.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, f.content, 'utf8')
  }
  await writeFile(join(dir, 'template.json'), JSON.stringify({ name: title, detail }, null, 2), 'utf8')
  return id
}

/** Your saved templates (any that can't be read are left out). */
export async function listUserTemplates(templatesDir: string): Promise<ProjectTemplate[]> {
  const out: ProjectTemplate[] = []
  const dirs = await readdir(templatesDir, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    try {
      const meta = JSON.parse(await readFile(join(templatesDir, d.name, 'template.json'), 'utf8')) as { name?: unknown; detail?: unknown }
      const files = (await textFiles(join(templatesDir, d.name, 'files'))).filter((f) => safeTemplatePath(f.path))
      if (!files.length) continue
      out.push({
        id: `user:${d.name}`,
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : d.name,
        detail: typeof meta.detail === 'string' && meta.detail ? meta.detail : `Your template · ${files.length} file${files.length === 1 ? '' : 's'}`,
        files,
        user: true
      })
    } catch {
      // not a template folder
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
