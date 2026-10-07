import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Mock only the external provider. Both runs use the shipped, built application.
const root = fileURLToPath(new URL('../', import.meta.url))
const project = resolve(root, 'validation-workspace/native-keyless')
await mkdir(project, { recursive: true })
const requests = []
let stage = 'write'
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  requests.push(parsed)
  if (stage === 'reject') {
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'fixture permission denied', type: 'permission_error' } }))
    return
  }
  const isTitle = parsed.max_tokens === 64
  const last = parsed.messages.at(-1)
  const tool = stage === 'write' ? 'write' : 'read'
  const shouldCall = !isTitle && last?.role !== 'tool'
  const delta = shouldCall
    ? { tool_calls: [{ index: 0, id: `call_${stage}`, type: 'function', function: {
      name: tool,
      arguments: JSON.stringify(stage === 'write'
        ? { file_path: 'native-proof.txt', content: 'native-proof: persisted across processes\n' }
        : { file_path: 'native-proof.txt' }),
    } }] }
    : { content: isTitle ? 'Native application proof' : 'NATIVE_PROOF_OK' }
  const chunk = (delta, finish_reason = null) => ({
    id: 'native-fixture', object: 'chat.completion.chunk', created: 1, model: 'mimo-v2.6-pro',
    choices: [{ index: 0, delta, finish_reason }],
  })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end([
    chunk(delta),
    { ...chunk({}, shouldCall ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/v1`
async function run(task, sessionId) {
  const patch = (await readFile(resolve(root, 'runtime/packages/bundle/nexgent-app/cordis.patch.yml'), 'utf8'))
    .replace('https://token-plan-cn.xiaomimimo.com/v1', endpoint)
  const patchPath = resolve(project, 'provider-fixture.patch.yml')
  await writeFile(patchPath, patch)
  const args = [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--patch', patchPath, '--json']
  if (sessionId) args.push('--session-id', sessionId)
  args.push('--', task)
  const child = spawn(process.execPath, args, { cwd: project, env: {
    ...process.env, DSH_HOME: resolve(project, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF',
    NEXGENT_API_KEY: 'keyless-fixture',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  const timer = setTimeout(() => child.kill(), 90_000)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  await writeFile(resolve(project, `run-${stage}.stdout.jsonl`), stdout)
  await writeFile(resolve(project, `run-${stage}.stderr.txt`), stderr)
  return { code, pid: child.pid, records: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
try {
  const first = await run('Write native-proof.txt with the text native-proof: persisted across processes.')
  assert.equal(first.code, 0, JSON.stringify(first.records.at(-1)))
  assert.ok(first.records.some(record => JSON.stringify(record).includes('call_write')), 'The first run must actually invoke write')
  assert.equal(await readFile(resolve(project, 'native-proof.txt'), 'utf8'), 'native-proof: persisted across processes\n')
  const sessionRecord = first.records.find(record => JSON.stringify(record).includes('session-'))
  const serialized = JSON.stringify(sessionRecord)
  const sessionId = serialized.match(/session-[0-9a-f-]+/)?.[0]
  assert.ok(sessionId, 'Native CLI must expose a durable Session identity')
  const boundary = requests.length
  stage = 'read'
  const second = await run('Read native-proof.txt again using the read tool. Confirm its contents.', sessionId)
  assert.equal(second.code, 0, JSON.stringify(second.records.at(-1)))
  assert.notEqual(second.pid, first.pid)
  assert.ok(requests.slice(boundary).some(request => request.messages.some(message => message.role === 'tool')), 'Resumed model request must contain prior tool history')
  assert.ok(second.records.some(record => JSON.stringify(record).includes('NATIVE_PROOF_OK')))
  assert.ok(second.records.some(record => JSON.stringify(record).includes('call_read')), 'The resumed run must actually invoke read')
  for (const request of requests.filter(request => request.max_tokens !== 64)) {
    assert.equal(request.model, 'mimo-v2.6-pro')
    assert.equal(request.thinking?.type, 'disabled')
    assert.ok(request.tools?.some(tool => tool.function.name === 'write'))
    assert.ok(!request.tools?.some(tool => /nexgent|taskservice/i.test(tool.function.name)))
    assert.equal(request.reasoning_effort, undefined)
  }
  stage = 'reject'
  const beforeReject = requests.length
  const rejected = await run('This provider call must fail.')
  assert.notEqual(rejected.code, 0)
  const forbiddenRequests = requests.slice(beforeReject).filter(request => request.max_tokens !== 64).length
  assert.equal(forbiddenRequests, 1, '403 must not trigger an automatic retry')
  const evidence = { passed: true, externalProvider: 'mock HTTP only', model: 'mimo-v2.6-pro', sessionId,
    firstPid: first.pid, resumedPid: second.pid, requestCount: requests.length, forbiddenRequests }
  await writeFile(resolve(project, 'requests.json'), JSON.stringify(requests, null, 2) + '\n')
  await writeFile(resolve(project, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
