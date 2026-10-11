#!/usr/bin/env node
/**
 * PowerShell launcher check (step-1 gap "`nexgent.ps1` 实跑"): runs a
 * write-file task through `apps/cli/bin/nexgent.ps1` against the scripted
 * model server, then checks the exit code, the written file and the `--json`
 * final event. Needs `pnpm build` and `pwsh` on PATH (CI: windows-latest).
 *
 * Usage: node scripts/accept-common/ps1-smoke.mjs
 * Exit codes: 0 pass; 1 fail; 2 not runnable (not built, or no pwsh).
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarness } from './harness.mjs'
import { buildScript, FILES, parseJsonLines, SCRIPTED_API_KEY, TASKS } from './scenario.mjs'

const PS1 = fileURLToPath(new URL('../../apps/cli/bin/nexgent.ps1', import.meta.url))
const TIMEOUT_MS = 120_000

function log(line) {
  process.stderr.write(`ps1-smoke: ${line}\n`)
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, error })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function main() {
  const loaded = await loadHarness()
  if (!loaded.ok) {
    log(`not runnable yet: ${loaded.reason}`)
    return 2
  }
  const probe = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], process.env)
  if (probe.code !== 0) {
    log(`not runnable: pwsh is not available (${probe.error?.message ?? probe.stderr.trim()})`)
    return 2
  }
  log(`pwsh ${probe.stdout.trim()}`)

  const work = await mkdtemp(join(tmpdir(), 'nexgent-ps1-smoke-'))
  const project = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(project)
  await mkdir(home)
  // Only the first two entries: tool call writing the file, then the answer.
  const server = await loaded.harness.scriptedModelServer({ script: buildScript().slice(0, 2) })
  try {
    const env = { ...process.env, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_HOME: home }
    const result = await run('pwsh', ['-NoProfile', '-NonInteractive', '-File', PS1, '-Project', project, '-Json', ...TASKS.write.split(' ')], env)
    const final = parseJsonLines(result.stdout).find(event => event.type === 'final')
    const written = await readFile(join(project, FILES.first.path), 'utf8').catch(() => undefined)
    const failures = []
    if (result.code !== 0) failures.push(`exit ${result.code}; stderr: ${result.stderr.trim().slice(-600)}`)
    if (written !== FILES.first.content) failures.push(`${FILES.first.path} is ${JSON.stringify(written)}`)
    if (final?.status !== 'completed') failures.push(`final event ${JSON.stringify(final)}`)
    if (server.remaining !== 0) failures.push(`scripted server has ${server.remaining} unused entries`)
    if (failures.length > 0) {
      log(`FAIL: ${failures.join('; ')}`)
      return 1
    }
    log(`nexgent.ps1 ran the task: exit 0, ${FILES.first.path} written, final status completed`)
    return 0
  } finally {
    await server.close()
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    process.exitCode = 1
  },
)
