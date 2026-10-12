/**
 * Run a replay case's recorded check specs against one run's project copy
 * (`data-formats.md` §任务快照与检查): the same three checks the host runs
 * at task end, with the same meaning — `file-exists`, `parses` (json, csv,
 * xlsx) and `test-command` (exit code 0 in the project root). The gate runs
 * them itself after the run's process has exited, so a run cannot report its
 * own result.
 */
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskCheck, TaskCheckSpec } from '@nexgent/kernel'
import { csvProblem, TEST_COMMAND_TIMEOUT_MS } from '@nexgent/tasking'

/** Environment variables a check command never sees (credentials). */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/** Options of {@link runCheckSpecs}. */
export interface RunChecksOptions {
  readonly signal?: AbortSignal
  /** Deadline of one test command (default `TEST_COMMAND_TIMEOUT_MS`). */
  readonly timeoutMs?: number
}

function absolute(root: string, path: string): string {
  return join(root, ...path.split('/'))
}

async function parseProblem(file: string, format: 'json' | 'csv' | 'xlsx'): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  if (format === 'xlsx') {
    const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const text = bytes.toString('latin1')
    return zip && text.includes('[Content_Types].xml') && text.includes('xl/workbook.xml') ? undefined : 'not an xlsx workbook'
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return 'not UTF-8 text'
  }
  if (format === 'json') {
    try {
      JSON.parse(text)
      return undefined
    } catch {
      return 'invalid JSON'
    }
  }
  return csvProblem(text)
}

function runCommand(root: string, spec: Extract<TaskCheckSpec, { name: 'test-command' }>, options: RunChecksOptions): Promise<Omit<TaskCheck, 'target'>> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !SECRET_ENV.test(name)) env[name] = value
  const [command, args] = spec.shell === 'bash'
    ? ['bash', ['-c', spec.command]]
    : ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', spec.command]]
  return new Promise(resolve => {
    let settled = false
    const done = (result: Omit<TaskCheck, 'target'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const child = spawn(command, args as string[], { cwd: root, env, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ name: spec.name, passed: false, detail: 'timed out' })
    }, options.timeoutMs ?? TEST_COMMAND_TIMEOUT_MS)
    const onAbort = () => {
      child.kill('SIGKILL')
      done({ name: spec.name, passed: false, detail: 'cancelled' })
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => done({ name: spec.name, passed: false, detail: `could not start: ${error.message}`.slice(0, 200) }))
    child.on('close', (code, signal) => done(code === 0
      ? { name: spec.name, passed: true }
      : { name: spec.name, passed: false, detail: `exit code ${code ?? `signal ${signal ?? 'unknown'}`}` }))
  })
}

/** Run every spec in `root`, in order; one result per spec with `target` = the spec id. */
export async function runCheckSpecs(root: string, specs: readonly TaskCheckSpec[], options: RunChecksOptions = {}): Promise<TaskCheck[]> {
  const results: TaskCheck[] = []
  for (const spec of specs) {
    let result: Omit<TaskCheck, 'target'>
    switch (spec.name) {
      case 'file-exists': {
        const info = await stat(absolute(root, spec.path)).catch(() => undefined)
        result = info?.isFile() === true ? { name: spec.name, passed: true } : { name: spec.name, passed: false, detail: 'missing' }
        break
      }
      case 'parses': {
        const problem = await parseProblem(absolute(root, spec.path), spec.format)
        result = problem === undefined ? { name: spec.name, passed: true } : { name: spec.name, passed: false, detail: problem }
        break
      }
      case 'test-command':
        result = await runCommand(root, spec, options)
        break
    }
    results.push({ ...result, target: spec.id })
  }
  return results
}
