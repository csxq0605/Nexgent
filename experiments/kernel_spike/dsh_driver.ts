/** Run the Stage A fixed-model spike through the official DSH headless profile. */

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const EXPECTED_UPSTREAM = '46a7f68b0922371ce7144b668b90e377d8e799f4'
const TASK = '计算 6 × 7 并交付 JSON {"answer":42}'
const TOOL = 'spike.multiply'
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const upstream = resolve(process.argv[2] ?? join(repo, '..', 'NExgent-upstream-deepseek-46a7f68'))
const patchPath = join(here, 'dsh_headless.patch.yml')
const pluginPath = join(here, 'dsh_spike_plugin.mjs')
const runRoot = await mkdtemp(join(resolve(repo, '..'), '.nexgent-dsh-spike-'))
const dshHome = join(runRoot, 'dsh-home')
const sessionRoot = join(runRoot, 'sessions')
const projectRoot = join(runRoot, 'project')
const sideReceiptPath = join(runRoot, 'plugin-receipts.jsonl')
const artifactRoot = join(runRoot, 'receipts')

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Row = { type?: string; data?: Record<string, Json>; [key: string]: Json | undefined }

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  try { await visit(root) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return found
}

function parseJsonl(text: string): Row[] {
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Row)
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function toolNames(row: Row): string[] {
  const header = row.data?.header
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return []
  const tools = header.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return []
    return typeof tool.name === 'string' ? [tool.name] : []
  })
}

async function gitHead(): Promise<string> {
  const head = (await readFile(join(upstream, '.git', 'HEAD'), 'utf8')).trim()
  if (!head.startsWith('ref: ')) return head
  return (await readFile(join(upstream, '.git', head.slice('ref: '.length)), 'utf8')).trim()
}

async function runHeadless(): Promise<{ code: number; stdout: string; stderr: string }> {
  await mkdir(projectRoot, { recursive: true })
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_BASE_URL
  Object.assign(env, {
    DSH_HOME: dshHome,
    DSH_SPIKE_SESSION_ROOT: sessionRoot,
    DSH_SPIKE_RECEIPT_PATH: sideReceiptPath,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
  })
  const command = process.execPath
  const args = [join(upstream, 'apps', 'cli', 'lib', 'bin.js'),
    '--profile', 'headless', '--patch', patchPath, '--json', TASK]
  const child = spawn(command, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const code = await new Promise<number>((resolveCode, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL') }, 90_000)
    child.on('error', reject)
    child.on('close', (value) => {
      clearTimeout(timeout)
      resolveCode(value ?? -1)
    })
  })
  return { code, stdout, stderr }
}

await mkdir(artifactRoot, { recursive: true })
try {
  const head = await gitHead()
  expect(head === EXPECTED_UPSTREAM, `upstream drift: expected ${EXPECTED_UPSTREAM}, got ${head}`)
  const processResult = await runHeadless()
  await writeFile(join(artifactRoot, 'stdout.jsonl'), processResult.stdout)
  await writeFile(join(artifactRoot, 'stderr.txt'), processResult.stderr)
  expect(processResult.code === 0, `headless exited ${processResult.code}; see ${join(artifactRoot, 'stderr.txt')}`)

  const stream = parseJsonl(processResult.stdout)
  const final = stream.at(-1)
  expect(final?.type === 'final' && final.text === '{"answer":42}', 'headless final answer mismatch')
  const sessionEvent = stream.find(row => row.type === 'session')
  expect(typeof sessionEvent?.sessionId === 'string', 'headless stream has no session id')

  const logFiles = (await filesBelow(sessionRoot)).filter(path => path.endsWith('.jsonl'))
  expect(logFiles.length === 2, `expected task and sibling-scope logs, found ${logFiles.length}`)
  const stored = await Promise.all(logFiles.map(async path => ({ path, text: await readFile(path, 'utf8') })))
  const taskStored = stored.find(value => parseJsonl(value.text)[0]?.id === sessionEvent.sessionId)
  const siblingStored = stored.find(value => parseJsonl(value.text)[0]?.id === 'dsh-spike-other-scope')
  expect(taskStored !== undefined, 'task Session log is missing')
  expect(siblingStored !== undefined, 'sibling-scope Session log is missing')
  const logText = taskStored.text
  await writeFile(join(artifactRoot, 'session.jsonl'), logText)
  await writeFile(join(artifactRoot, 'sibling-session.jsonl'), siblingStored.text)
  const log = parseJsonl(logText)
  const headers = log.filter(row => row.type === 'request/header')
  expect(headers.length >= 2, 'tool removal did not create a second request/header')
  expect(toolNames(headers[0]!).length === 1 && toolNames(headers[0]!)[0] === TOOL,
    'initial model request did not expose exactly the scoped multiply tool')
  expect(headers.slice(1).every(row => !toolNames(row).includes(TOOL)),
    'multiply remained model-visible after unload')

  const calls = log.filter(row => row.type === 'tool/call')
  const results = log.filter(row => row.type === 'tool/result')
  expect(calls.length === 2 && calls.every(row => row.data?.name === TOOL),
    'expected successful call and post-unload retry of multiply')
  expect(calls[0]?.data?.arguments === '{"left":6,"right":7}', 'multiply arguments differ from the contract')
  const firstMessage = results[0]?.data?.message
  const secondMessage = results[1]?.data?.message
  expect(firstMessage !== null && typeof firstMessage === 'object' && !Array.isArray(firstMessage)
    && firstMessage.isError === false && JSON.stringify(firstMessage).includes('{\\"value\\":42}'),
  'first multiply result was not the successful value 42')
  expect(secondMessage !== null && typeof secondMessage === 'object' && !Array.isArray(secondMessage)
    && secondMessage.isError === true && JSON.stringify(secondMessage).includes(`unknown tool \\"${TOOL}\\"`),
  'post-unload multiply call did not fail as unknown')

  const sideText = await readFile(sideReceiptPath, 'utf8')
  await writeFile(join(artifactRoot, 'plugin-receipts.jsonl'), sideText)
  const side = parseJsonl(sideText)
  const scopeProbe = side.find(row => row.type === 'scope_probe')
  expect(scopeProbe !== undefined && Array.isArray(scopeProbe.schemas)
    && !scopeProbe.schemas.includes(TOOL) && scopeProbe.isError === true,
  'second Agent scope could see or execute multiply')
  expect(side.some(row => row.type === 'tool_unloaded'), 'tool unload receipt is missing')
  const modelRequests = side.filter(row => row.type === 'model_request')
  expect(modelRequests.length === 3, `expected three fixed-model requests, got ${modelRequests.length}`)
  expect(JSON.stringify(modelRequests[0]?.tools) === JSON.stringify([TOOL]),
    'fixed model did not receive multiply on its first request')
  expect(modelRequests.slice(1).every(row => Array.isArray(row.tools) && !row.tools.includes(TOOL)),
    'fixed model still received multiply after unload')

  const profileManifest = join(dshHome, 'profiles', 'headless', 'package.json')
  await writeFile(join(artifactRoot, 'profile-package.json'), await readFile(profileManifest, 'utf8'))
  const pluginSha256 = createHash('sha256').update(await readFile(pluginPath)).digest('hex')
  const summary = {
    passed: true,
    backend: 'deepseek-harness',
    upstreamCommit: head,
    profile: 'headless',
    model: 'spike-mock/fixed',
    taskSessionId: sessionEvent.sessionId,
    siblingSessionId: 'dsh-spike-other-scope',
    pluginSha256,
    task: TASK,
    final: final.text,
    assertions: {
      installedInTaskScope: true,
      hiddenFromSiblingScope: true,
      firstCallReturned42: true,
      unloadedBeforeSecondRequest: true,
      postUnloadCallFailed: true,
      durableRawLogCopied: true,
      externalProviderInvoked: false,
    },
    isolation: 'Agent-scoped registry only; the fixture plugin executes in the host process and is not an OS sandbox.',
    sourcePaths: { upstream, patchPath, pluginPath },
  }
  await writeFile(join(artifactRoot, 'summary.json'), JSON.stringify(summary, undefined, 2) + '\n')
  process.stdout.write(`${JSON.stringify({ ...summary, artifactRoot }, undefined, 2)}\n`)
} catch (error: unknown) {
  const failure = {
    passed: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    temporaryRoot: runRoot,
    artifactRoot,
  }
  await writeFile(join(artifactRoot, 'failure.json'), JSON.stringify(failure, undefined, 2) + '\n')
  process.stderr.write(`${JSON.stringify(failure, undefined, 2)}\n`)
  process.exitCode = 1
}
