/** Run one bounded real-MiMo tool task through the official DSH headless profile. */

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_UPSTREAM = '46a7f68b0922371ce7144b668b90e377d8e799f4'
const PROVIDER = 'nexgent-mimo-local'
const MODEL = 'mimo-v2.6-flash'
const TOOL = 'spike.multiply'
const CREDENTIAL_REF = 'NEXGENT_API_KEY'
const TASK = 'Use the available multiply tool exactly once with left=6 and right=7. After the tool result, reply with exactly the JSON object {"answer":42} and no other text.'
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const upstream = resolve(process.argv.find(value => value.startsWith('--upstream='))?.slice('--upstream='.length)
  ?? join(repo, '..', 'NExgent-upstream-deepseek-46a7f68'))
const modelProject = resolve(process.argv.find(value => value.startsWith('--model-project='))?.slice('--model-project='.length)
  ?? join(repo, '..', 'NExgent'))
const preflightOnly = process.argv.includes('--preflight')
const patchPath = join(here, 'dsh_mimo.patch.yml')
const pluginPath = join(here, 'dsh_mimo_plugin.mjs')
const llmEntry = join(upstream, 'packages', 'llm', 'llm', 'lib', 'index.js')

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Row = { type?: string; id?: string; sessionId?: string; text?: string; data?: Record<string, Json>; [key: string]: Json | undefined }

class DriverFailure extends Error {
  readonly failureClass: string
  readonly stage: string
  readonly remoteOutcomeUnknown: boolean

  constructor(failureClass: string, stage: string, message: string,
    remoteOutcomeUnknown = false) {
    super(message)
    this.failureClass = failureClass
    this.stage = stage
    this.remoteOutcomeUnknown = remoteOutcomeUnknown
  }
}

function expect(condition: unknown, failureClass: string, stage: string, message: string): asserts condition {
  if (!condition) throw new DriverFailure(failureClass, stage, message)
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256(path: string): Promise<string> {
  return sha256Bytes(await readFile(path))
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeBaseUrl(raw: unknown): string {
  expect(typeof raw === 'string', 'config_preflight', 'endpoint_validation', 'provider base URL is missing')
  let parsed: URL
  try { parsed = new URL(raw) } catch {
    throw new DriverFailure('config_preflight', 'endpoint_validation', 'provider base URL is invalid')
  }
  expect(parsed.protocol === 'https:'
    && ['token-plan-cn.xiaomimimo.com', 'api.xiaomimimo.com'].includes(parsed.hostname)
    && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && /^\/v1\/?$/u.test(parsed.pathname),
  'config_preflight', 'endpoint_validation', 'provider base URL is outside the fixed MiMo allowlist')
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`
}

function dotenvValue(text: string, name: string): string {
  let found: string | undefined
  for (const raw of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    line = line.replace(/^export\s+/u, '')
    const separator = line.indexOf('=')
    if (separator < 1 || line.slice(0, separator).trim() !== name) continue
    expect(found === undefined, 'config_preflight', 'credential_resolve', 'credential reference is duplicated')
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    found = value
  }
  expect(typeof found === 'string' && found.trim() !== '',
    'config_preflight', 'credential_resolve', 'credential reference is not configured')
  return found
}

interface Profile {
  identity: Record<string, Json>
  digest: string
  apiKey: string
  targetOverride: boolean
}

async function loadProfile(): Promise<Profile> {
  const modelsPath = join(modelProject, 'models.json')
  const dotenvPath = join(modelProject, '.env')
  const [modelsStat, dotenvStat] = await Promise.all([stat(modelsPath), stat(dotenvPath)])
  expect(modelsStat.size > 0 && modelsStat.size <= 64 * 1024,
    'config_preflight', 'config_read', 'models.json is empty or too large')
  expect(dotenvStat.size > 0 && dotenvStat.size <= 64 * 1024,
    'config_preflight', 'config_read', '.env is empty or too large')
  const [modelsText, dotenvText] = await Promise.all([
    readFile(modelsPath, 'utf8'), readFile(dotenvPath, 'utf8'),
  ])
  let data: any
  try { data = JSON.parse(modelsText) } catch {
    throw new DriverFailure('config_preflight', 'config_parse', 'models.json is not valid JSON')
  }
  const provider = data?.providers?.mimo
  expect(provider !== null && typeof provider === 'object' && !Array.isArray(provider),
    'config_preflight', 'config_schema', 'models.json has no mimo provider object')
  expect(provider.api_key === `\${${CREDENTIAL_REF}}`,
    'config_preflight', 'credential_reference', 'mimo provider does not use the fixed credential reference')
  const models = provider.models
  const configuredModels: string[] = Array.isArray(models)
    ? models.flatMap((item: unknown) => typeof item === 'string' ? [item]
      : item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [])
    : models !== null && typeof models === 'object' && !Array.isArray(models) ? Object.keys(models) : []
  expect(configuredModels.includes('mimo-v2.5'), 'config_preflight', 'config_schema', 'source MiMo catalog is missing v2.5')
  const apiKey = dotenvValue(dotenvText, CREDENTIAL_REF)
  const identity: Record<string, Json> = {
    provider: 'mimo',
    base_url: normalizeBaseUrl(provider.base_url),
    model: MODEL,
    credential_ref: CREDENTIAL_REF,
    models_json_sha256: sha256Bytes(Buffer.from(modelsText, 'utf8')),
  }
  return {
    identity,
    digest: sha256Bytes(Buffer.from(canonical(identity), 'utf8')),
    apiKey,
    targetOverride: !configuredModels.includes(MODEL),
  }
}

async function gitHead(): Promise<string> {
  const head = (await readFile(join(upstream, '.git', 'HEAD'), 'utf8')).trim()
  if (!head.startsWith('ref: ')) return head
  return (await readFile(join(upstream, '.git', head.slice('ref: '.length)), 'utf8')).trim()
}

async function sourceIdentity(): Promise<Record<string, Json>> {
  const head = await gitHead()
  expect(head === EXPECTED_UPSTREAM, 'config_preflight', 'source_identity', 'fixed DSH upstream commit drifted')
  const trackedStatus = spawnSync('git', ['-c', `safe.directory=${upstream.replaceAll('\\', '/')}`,
    'status', '--porcelain', '--untracked-files=no'], { cwd: upstream, encoding: 'utf8' })
  expect(trackedStatus.status === 0 && trackedStatus.stdout.trim() === '',
    'config_preflight', 'source_identity', 'fixed DSH tracked source is dirty')
  return {
    upstream_commit: head,
    built_entrypoint_sha256: await sha256(join(upstream, 'apps', 'cli', 'lib', 'bin.js')),
    llm_entry_sha256: await sha256(llmEntry),
    lockfile_sha256: await sha256(join(upstream, 'pnpm-lock.yaml')),
    patch_sha256: await sha256(patchPath),
    plugin_sha256: await sha256(pluginPath),
    driver_sha256: await sha256(fileURLToPath(import.meta.url)),
  }
}

function parseJsonl(text: string): Row[] {
  return text.split(/\r?\n/u).filter(line => line.trim() !== '').map(line => JSON.parse(line) as Row)
}

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

function redact(text: string, secret: string): { text: string; leaked: boolean } {
  const leaked = secret.length > 0 && text.includes(secret)
  return { text: leaked ? text.replaceAll(secret, '[REDACTED-CREDENTIAL]') : text, leaked }
}

async function scrubGeneratedSecrets(root: string, secret: string): Promise<string[]> {
  const hits: string[] = []
  for (const path of await filesBelow(root)) {
    const info = await stat(path)
    if (info.size > 10 * 1024 * 1024) continue
    const buffer = await readFile(path)
    if (buffer.indexOf(Buffer.from(secret, 'utf8')) < 0) continue
    const cleaned = buffer.toString('utf8').replaceAll(secret, '[REDACTED-CREDENTIAL]')
    await writeFile(path, cleaned, 'utf8')
    hits.push(relative(root, path))
  }
  return hits.sort()
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await writeFile(destination, await readFile(source))
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function objectValue(value: Json | undefined): Record<string, Json> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Json> : undefined
}

function resultCallId(row: Row): string | undefined {
  const message = objectValue(row.data?.message)
  const source = objectValue(message?.source)
  return typeof source?.callId === 'string' ? source.callId
    : typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
}

const profile = await loadProfile()
const sources = await sourceIdentity()
const preflight = {
  schema: 'nexgent.dsh-mimo-live-preflight.v1',
  passed: true,
  backend: 'deepseek-harness',
  profile: 'headless',
  profile_identity: profile.identity,
  profile_digest: profile.digest,
  credential_configured: true,
  target_model_override: profile.targetOverride,
  source_identity: sources,
  budget: {
    provider_requests: 2,
    max_completion_tokens_per_request: 256,
    reserved_completion_tokens: 512,
    tool_calls: 1,
    retries: 0,
    request_timeout_seconds: 90,
  },
}
if (preflightOnly) {
  process.stdout.write(`${JSON.stringify(preflight, undefined, 2)}\n`)
} else {
  const runRoot = await mkdtemp(join(resolve(repo, '..'), '.nexgent-dsh-mimo-'))
  const dshHome = join(runRoot, 'dsh-home')
  const sessionRoot = join(runRoot, 'sessions')
  const projectRoot = join(runRoot, 'project')
  const sideReceiptPath = join(runRoot, 'plugin-receipts.jsonl')
  const artifactRoot = join(runRoot, 'receipts')
  await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(artifactRoot, { recursive: true })])
  await Promise.all([
    writeFile(join(artifactRoot, 'executed-dsh_mimo_plugin.mjs'), await readFile(pluginPath)),
    writeFile(join(artifactRoot, 'executed-dsh_mimo.patch.yml'), await readFile(patchPath)),
    writeFile(join(artifactRoot, 'executed-dsh_mimo_driver.ts'), await readFile(fileURLToPath(import.meta.url))),
  ])

  let stage = 'launch'
  let processCode: number | null = null
  let processSignal: NodeJS.Signals | null = null
  let processTimedOut = false
  let stdout = ''
  let stderr = ''
  let leakedOutputs: string[] = []
  try {
    const env = { ...process.env }
    delete env.NEXGENT_API_KEY
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
    Object.assign(env, {
      DSH_HOME: dshHome,
      DSH_MIMO_SESSION_ROOT: sessionRoot,
      DSH_MIMO_RECEIPT_PATH: sideReceiptPath,
      DSH_MIMO_MODEL_PROJECT: modelProject,
      DSH_MIMO_LLM_ENTRY: llmEntry,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    })
    const command = process.execPath
    const args = [join(upstream, 'apps', 'cli', 'lib', 'bin.js'),
      '--profile', 'headless', '--patch', patchPath, '--json', TASK]
    const child = spawn(command, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        processTimedOut = true
        child.kill('SIGKILL')
      }, 195_000)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }) })
    })
    processCode = exit.code
    processSignal = exit.signal
    stage = 'sanitize_outputs'
    const safeStdout = redact(stdout, profile.apiKey)
    const safeStderr = redact(stderr, profile.apiKey)
    stdout = safeStdout.text
    stderr = safeStderr.text
    await Promise.all([
      writeFile(join(artifactRoot, 'stdout.jsonl'), stdout),
      writeFile(join(artifactRoot, 'stderr.txt'), stderr),
    ])
    if (safeStdout.leaked) leakedOutputs.push('captured-stdout')
    if (safeStderr.leaked) leakedOutputs.push('captured-stderr')
    leakedOutputs.push(...await scrubGeneratedSecrets(runRoot, profile.apiKey))
    leakedOutputs = [...new Set(leakedOutputs)].sort()
    expect(leakedOutputs.length === 0, 'evidence_persistence', 'secret_leak_scan', 'generated output contained the configured credential and was redacted')

    stage = 'collect_receipts'
    expect(processCode === 0 && processSignal === null && !processTimedOut,
      processTimedOut ? 'transport' : 'execution', 'headless_exit', 'headless live smoke did not exit successfully')
    const stream = parseJsonl(stdout)
    const final = stream.at(-1)
    expect(final?.type === 'final' && typeof final.text === 'string',
      'final_semantics', 'stdout_final', 'headless stream has no final record')
    let finalValue: unknown
    try { finalValue = JSON.parse(final.text) } catch {
      throw new DriverFailure('final_semantics', 'stdout_final', 'headless final is not JSON')
    }
    expect(JSON.stringify(finalValue) === '{"answer":42}',
      'final_semantics', 'stdout_final', 'headless final differs from the fixed answer')
    const sessionEvent = stream.find(row => row.type === 'session')
    expect(typeof sessionEvent?.sessionId === 'string',
      'evidence_persistence', 'stdout_session', 'headless stream has no session id')

    const sessionFiles = (await filesBelow(sessionRoot)).filter(path => path.endsWith('.jsonl'))
    expect(sessionFiles.length === 1, 'evidence_persistence', 'session_log', 'expected exactly one persisted Session JSONL')
    const sessionText = await readFile(sessionFiles[0]!, 'utf8')
    const session = parseJsonl(sessionText)
    expect(session[0]?.type === 'session' && session[0]?.id === sessionEvent.sessionId,
      'evidence_persistence', 'session_identity', 'persisted Session identity differs from stdout')
    await writeFile(join(artifactRoot, 'session.jsonl'), sessionText)

    const sideText = await readFile(sideReceiptPath, 'utf8')
    const side = parseJsonl(sideText)
    await writeFile(join(artifactRoot, 'plugin-receipts.jsonl'), sideText)
    expect(side.every((row, index) => row.seq === index),
      'evidence_persistence', 'side_receipts', 'plugin receipt sequence is not contiguous')
    const loaded = side.filter(row => row.type === 'profile_loaded')
    expect(loaded.length === 1 && loaded[0]?.profile_digest === profile.digest
      && JSON.stringify(loaded[0]?.profile_identity) === JSON.stringify(profile.identity),
    'evidence_persistence', 'profile_receipt', 'plugin profile identity differs from driver preflight')
    const starts = side.filter(row => row.type === 'provider_request_started')
    const responses = side.filter(row => row.type === 'provider_response_received')
    const failures = side.filter(row => row.type === 'adapter_failure')
    expect(starts.length === 2 && responses.length === 2 && failures.length === 0,
      'evidence_persistence', 'provider_receipts', 'expected exactly two received provider calls and no adapter failure')
    expect(starts.every((row, index) => row.ordinal === index + 1 && row.configured_model === MODEL
      && row.profile_digest === profile.digest && row.max_completion_tokens === 256),
    'evidence_persistence', 'provider_receipts', 'provider start receipts differ from the fixed budget or identity')
    expect(responses.every((row, index) => row.ordinal === index + 1
      && row.configured_model === MODEL && row.observed_model === MODEL
      && row.profile_digest === profile.digest),
    'model_identity_mismatch', 'provider_receipts', 'provider response identity differs from the fixed target')
    expect(responses[0]?.outcome === 'native_tool_call' && responses[0]?.tool_name === TOOL,
      'provider_protocol', 'native_tool_call', 'first provider response is not the required native tool call')
    expect(responses[1]?.outcome === 'final_json' && responses[1]?.final === '{"answer":42}',
      'final_semantics', 'provider_final', 'second provider response is not the fixed final JSON')

    const toolReceipts = side.filter(row => row.type === 'tool_executed')
    expect(toolReceipts.length === 1 && toolReceipts[0]?.tool === TOOL
      && JSON.stringify(toolReceipts[0]?.arguments) === '{"left":6,"right":7}'
      && JSON.stringify(toolReceipts[0]?.result) === '{"value":42}',
    'tool_contract', 'tool_receipt', 'diagnostic tool did not execute exactly once with the fixed input/result')

    const headers = session.filter(row => row.type === 'request/header')
    const calls = session.filter(row => row.type === 'tool/call')
    const results = session.filter(row => row.type === 'tool/result')
    const assistants = session.filter(row => row.type === 'assistant/message')
    expect(headers.length === 2 && calls.length === 1 && results.length === 1 && assistants.length === 2,
      'evidence_persistence', 'session_counts', 'persisted Session does not contain the two-call/one-tool flow')
    expect(calls[0]?.data?.name === TOOL && calls[0]?.data?.arguments === '{"left":6,"right":7}',
      'tool_contract', 'session_tool_call', 'persisted tool call differs from the fixed contract')
    expect(resultCallId(results[0]!) === calls[0]?.data?.callId
      && JSON.stringify(results[0]?.data).includes('{\\"value\\":42}'),
    'tool_contract', 'session_tool_result', 'persisted tool result is not correlated value 42')
    const firstMessage = objectValue(assistants[0]?.data?.message)
    const firstContent = firstMessage?.content
    expect(Array.isArray(firstContent) && firstContent.length === 1
      && objectValue(firstContent[0])?.type === 'tool-call'
      && objectValue(firstContent[0])?.name === TOOL,
    'provider_protocol', 'session_assistant_tool_call', 'persisted assistant message has no provider-native tool call')
    expect(objectValue(firstMessage?.source)?.provider === PROVIDER
      && objectValue(firstMessage?.source)?.model === MODEL,
    'model_identity_mismatch', 'session_assistant_identity', 'persisted assistant source differs from the fixed route')

    const profilePackage = join(dshHome, 'profiles', 'headless', 'package.json')
    await writeFile(join(artifactRoot, 'profile-package.json'), await readFile(profilePackage))
    const receiptFiles = ['stdout.jsonl', 'stderr.txt', 'session.jsonl',
      'plugin-receipts.jsonl', 'profile-package.json',
      'executed-dsh_mimo_plugin.mjs', 'executed-dsh_mimo.patch.yml', 'executed-dsh_mimo_driver.ts']
    const receiptSha256 = Object.fromEntries(await Promise.all(receiptFiles.map(async name =>
      [name, await sha256(join(artifactRoot, name))] as const)))
    const totalUsage = responses.reduce((result, row) => {
      const usage = objectValue(row.usage)
      result.input_tokens += typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0
      result.output_tokens += typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0
      result.total_tokens += typeof usage?.totalTokens === 'number' ? usage.totalTokens : 0
      return result
    }, { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    const summary = {
      schema: 'nexgent.dsh-mimo-live-result.v1',
      passed: true,
      backend: 'deepseek-harness',
      profile: 'headless',
      profile_identity: profile.identity,
      profile_digest: profile.digest,
      credential_configured: true,
      secret_leak_scan_passed: true,
      source_identity: sources,
      session_id: sessionEvent.sessionId,
      task: TASK,
      configured_model: MODEL,
      observed_models: responses.map(row => row.observed_model),
      provider_requests: starts.length,
      tool_executions: toolReceipts.length,
      usage: totalUsage,
      final: final.text,
      receipt_sha256: receiptSha256,
      assertions: {
        fixed_headless_profile: true,
        target_model_override_explicit: profile.targetOverride,
        native_provider_tool_call: true,
        diagnostic_handler_only: true,
        exactly_two_provider_completions: true,
        exactly_one_tool_execution: true,
        zero_retry_policy: true,
      },
      limitations: [
        'The multiply handler is hand-written diagnostic code; the model did not develop it.',
        'This is one connectivity task, not benchmark quality or RSI evidence.',
        'The trusted plugin reads the credential in the host process and is not an OS sandbox.',
      ],
      artifact_root: artifactRoot,
    }
    await writeFile(join(artifactRoot, 'summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
    const finalLeaks = await scrubGeneratedSecrets(runRoot, profile.apiKey)
    expect(finalLeaks.length === 0, 'evidence_persistence', 'secret_leak_scan', 'final generated evidence contained the configured credential')
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
  } catch (error: unknown) {
    const safeStdout = redact(stdout, profile.apiKey)
    const safeStderr = redact(stderr, profile.apiKey)
    await Promise.all([
      writeFile(join(artifactRoot, 'stdout.jsonl'), safeStdout.text),
      writeFile(join(artifactRoot, 'stderr.txt'), safeStderr.text),
    ])
    leakedOutputs.push(...safeStdout.leaked ? ['captured-stdout'] : [])
    leakedOutputs.push(...safeStderr.leaked ? ['captured-stderr'] : [])
    leakedOutputs.push(...await scrubGeneratedSecrets(runRoot, profile.apiKey))
    const copied: string[] = []
    if (await copyIfPresent(sideReceiptPath, join(artifactRoot, 'plugin-receipts.jsonl'))) copied.push('plugin-receipts.jsonl')
    const sessionFiles = (await filesBelow(sessionRoot)).filter(path => path.endsWith('.jsonl'))
    for (let index = 0; index < sessionFiles.length; index++) {
      const name = `session-${index + 1}.jsonl`
      await writeFile(join(artifactRoot, name), await readFile(sessionFiles[index]!))
      copied.push(name)
    }
    if (await copyIfPresent(join(dshHome, 'profiles', 'headless', 'package.json'),
      join(artifactRoot, 'profile-package.json'))) copied.push('profile-package.json')
    let classified = error instanceof DriverFailure ? error : undefined
    let side: Row[] = []
    try { side = parseJsonl(await readFile(sideReceiptPath, 'utf8')) } catch {}
    const adapterFailure = side.filter(row => row.type === 'adapter_failure').at(-1)
    if (adapterFailure !== undefined) {
      classified = new DriverFailure(
        typeof adapterFailure.failure_class === 'string' ? adapterFailure.failure_class : 'execution',
        typeof adapterFailure.stage === 'string' ? adapterFailure.stage : stage,
        'DSH live adapter recorded a classified failure',
        adapterFailure.remote_outcome_unknown === true,
      )
    }
    if (processTimedOut) classified = new DriverFailure('transport', 'driver_timeout', 'headless process exceeded the fixed task timeout', true)
    classified ??= new DriverFailure('execution', stage, 'DSH live smoke failed without a classified result')
    const receiptSha256 = Object.fromEntries(await Promise.all(
      (await filesBelow(artifactRoot)).filter(path => basename(path) !== 'failure.json').map(async path =>
        [basename(path), await sha256(path)] as const)))
    const failure = {
      schema: 'nexgent.dsh-mimo-live-failure.v1',
      passed: false,
      backend: 'deepseek-harness',
      profile: 'headless',
      profile_identity: profile.identity,
      profile_digest: profile.digest,
      credential_configured: true,
      secret_leak_scan_passed: leakedOutputs.length === 0,
      failure_class: classified.failureClass,
      stage: classified.stage,
      remote_outcome_unknown: classified.remoteOutcomeUnknown,
      process: { code: processCode, signal: processSignal, timed_out: processTimedOut },
      provider_requests_started: side.filter(row => row.type === 'provider_request_started').length,
      provider_responses_received: side.filter(row => row.type === 'provider_response_received').length,
      retries: 0,
      copied_receipts: copied,
      receipt_sha256: receiptSha256,
      source_identity: sources,
      artifact_root: artifactRoot,
    }
    await writeFile(join(artifactRoot, 'failure.json'), `${JSON.stringify(failure, undefined, 2)}\n`)
    await scrubGeneratedSecrets(runRoot, profile.apiKey)
    process.stderr.write(`${JSON.stringify(failure, undefined, 2)}\n`)
    process.exitCode = 1
  }
}
