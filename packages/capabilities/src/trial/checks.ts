/**
 * Run a replay case's recorded check specs against one run's project copy
 * (`data-formats.md` §任务快照与检查): the same three checks the host runs
 * at task end, with the same meaning — `file-exists`, `parses` (json, csv,
 * xlsx) and `test-command` (exit code 0 in the project root). The gate runs
 * them itself after the run's process has exited, so a run cannot report its
 * own result.
 *
 * ADR 0014: the `file-exists` and `parses` specs name the files the original
 * run happened to present. In a replay the path is the original run's
 * choice, not the task's requirement: when the replay run presented its
 * deliverables ({@link RunChecksOptions.delivered}) and a recorded path is
 * missing, the check takes the next file the run presented that has the same
 * extension and is not at a recorded path (one file per recorded path, in
 * presentation order). A run that renamed or moved its output therefore
 * passes as long as it delivered a file of that kind; a run that presented
 * nothing of that kind still fails.
 */
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { TaskCheck, TaskCheckSpec } from '@nexgent/kernel'
import { csvProblem } from '@nexgent/tasking'

/** Deadline of one test command in a trial copy. */
export const TEST_COMMAND_TIMEOUT_MS = 120_000

/** Environment variables a check command never sees (credentials). */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/** Options of {@link runCheckSpecs}. */
export interface RunChecksOptions {
  readonly signal?: AbortSignal
  /** Deadline of one test command (default `TEST_COMMAND_TIMEOUT_MS`). */
  readonly timeoutMs?: number
  /** ADR 0014: the project-relative files the run presented as deliverables, in presentation order (absent: recorded paths only). */
  readonly delivered?: readonly string[]
}

async function isFile(root: string, path: string): Promise<boolean> {
  return (await stat(absolute(root, path)).catch(() => undefined))?.isFile() === true
}

/** ADR 0014: where each recorded deliverable path is checked (itself, or the presented file standing in for it). */
async function deliveredPaths(root: string, specs: readonly TaskCheckSpec[], delivered: readonly string[] | undefined): Promise<Map<string, string>> {
  const recorded = [...new Set(specs.flatMap(spec => (spec.name === 'test-command' ? [] : [spec.path])))]
  const where = new Map<string, string>()
  if (delivered === undefined) return where
  const taken = new Set(recorded)
  for (const path of recorded) {
    if (await isFile(root, path)) continue
    const extension = posix.extname(path).toLowerCase()
    for (const candidate of delivered) {
      if (taken.has(candidate) || posix.extname(candidate).toLowerCase() !== extension || !(await isFile(root, candidate))) continue
      taken.add(candidate)
      where.set(path, candidate)
      break
    }
  }
  return where
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
  const standIn = await deliveredPaths(root, specs, options.delivered)
  const moved = { detail: 'delivered under another path' }
  for (const spec of specs) {
    let result: Omit<TaskCheck, 'target'>
    switch (spec.name) {
      case 'file-exists': {
        const path = standIn.get(spec.path) ?? spec.path
        result = await isFile(root, path) ? { name: spec.name, passed: true, ...(path === spec.path ? {} : moved) } : { name: spec.name, passed: false, detail: 'missing' }
        break
      }
      case 'parses': {
        const path = standIn.get(spec.path) ?? spec.path
        const problem = await parseProblem(absolute(root, path), spec.format)
        result = problem === undefined ? { name: spec.name, passed: true, ...(path === spec.path ? {} : moved) } : { name: spec.name, passed: false, detail: problem }
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
