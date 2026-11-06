/**
 * Discovering and running the project's Python tests.
 * pytest is used when it's installed (results from its JUnit XML report);
 * otherwise unittest (results from its -v output). Output streams to the
 * window as it comes, so long test runs show progress.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { listFiles } from './listFiles'
import { findTests, isTestFile, type TestFile } from '../shared/tests'
import type { TestRunRequest, TestRunResult } from '../shared/api'
import { processEnvSync } from './dotenvFile'

/** Test files in the project and the tests in each. */
export async function discoverTests(root: string): Promise<TestFile[]> {
  const files = (await listFiles(root)).filter((f) => isTestFile(f.rel)).slice(0, 2000)
  const out: TestFile[] = []
  for (const f of files) {
    try {
      if ((await stat(f.path)).size > 2_000_000) continue
      const tests = findTests(await readFile(f.path, 'utf8'))
      if (tests.length) out.push({ path: f.path, rel: f.rel.replace(/\\/g, '/'), tests })
    } catch {
      // unreadable: skip
    }
  }
  return out
}

export function hasPytest(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(python, ['-c', 'import pytest'], { timeout: 20000, windowsHide: true }, (err) => resolve(!err))
  })
}

let runCount = 0

export class TestRunner {
  private child: ChildProcess | null = null

  /** Run tests; output is streamed as 'tests:output'. Resolves when they finish. */
  async run(sender: WebContents, req: TestRunRequest): Promise<TestRunResult> {
    this.stop()
    const xmlPath = join(tmpdir(), `ideforfun-pytest-${process.pid}-${++runCount}.xml`)
    const args = req.framework === 'pytest'
      ? ['-m', 'pytest', '-o', 'junit_family=xunit1', `--junitxml=${xmlPath}`, '--color=no', '-q', ...req.ids]
      : ['-m', 'unittest', '-v', ...(req.ids.length ? req.ids : ['discover'])]
    const started = Date.now()
    let output = ''
    const code = await new Promise<number | null | 'failed'>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(req.python, args, {
          cwd: req.root,
          env: processEnvSync(req.root, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }),
          windowsHide: true
        })
      } catch (err) {
        output = String(err)
        resolve('failed')
        return
      }
      this.child = child
      const onData = (text: string) => {
        output += text
        if (!sender.isDestroyed()) sender.send('tests:output', text)
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.stdin?.on('error', () => {})
      child.once('error', (err) => {
        output += String(err)
        resolve('failed')
      })
      child.once('close', (c) => {
        if (this.child === child) this.child = null
        resolve(c)
      })
    })
    let xml: string | undefined
    if (req.framework === 'pytest') {
      try {
        xml = await readFile(xmlPath, 'utf8')
      } catch { /* no report: pytest failed before running anything */ }
      void unlink(xmlPath).catch(() => {})
    }
    return {
      exitCode: code === 'failed' ? null : code,
      output,
      xml,
      seconds: (Date.now() - started) / 1000,
      error: code === 'failed' ? `Couldn't start ${req.python}` : undefined
    }
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
  }
}
