import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const parent = resolve(root, 'validation-workspace')
await mkdir(parent, { recursive: true })
const project = await mkdtemp(resolve(parent, 'native-architecture-'))
const schema = { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] }
const architecture = { nodes: [
  { id: 'a', role: 'researcher', prompt: 'GRAPH_MEMBER_A', dependencies: [], provider: 'mimo', model: 'mimo-v2.6-pro', schema },
  { id: 'b', role: 'researcher', prompt: 'GRAPH_MEMBER_B', dependencies: [], provider: 'mimo', model: 'mimo-v2.6-pro', schema },
  { id: 'review', role: 'reviewer', prompt: 'GRAPH_MEMBER_REVIEW', dependencies: ['a', 'b'], provider: 'mimo', model: 'mimo-v2.6-pro', schema },
] }
const requests = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  requests.push(parsed)
  if (requests.length > 40) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Unexpected repeated request in graph fixture' } }))
    return
  }
  // Native runtime context is also a user message; match the actual task,
  // leaving those policy snapshots intact in the request being exercised.
  const last = parsed.messages.findLast(message => message.role !== 'user' || !String(message.content).startsWith('Current runtime context.'))
  const task = parsed.messages.findLast(message => message.role === 'user' && !String(message.content).startsWith('Current runtime context.'))
  const text = JSON.stringify(task?.content)
  const isTitle = parsed.max_tokens === 64
  let delta
  if (isTitle) delta = { content: 'Architecture proof' }
  else if (text.includes('GRAPH_MEMBER_REVIEW')) {
    assert.ok(text.includes('RESULT_A') && text.includes('RESULT_B'), 'Reviewer must receive actual predecessor outputs')
    delta = structured('RESULT_REVIEW')
  } else if (text.includes('GRAPH_MEMBER_A') || text.includes('GRAPH_MEMBER_B')) {
    const member = text.includes('GRAPH_MEMBER_A') ? 'a' : 'b'
    const value = `RESULT_${member.toUpperCase()}`
    const calls = parsed.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
    if (calls.length === 0) delta = tool(`read_${member}_before`, 'read', { file_path: `${member}.json` })
    else if (calls.length === 1) delta = tool(`write_${member}`, 'write', { file_path: `${member}.json`, content: JSON.stringify({ value }) })
    else if (calls.length === 2 && JSON.stringify(last?.content).includes('read-only')) delta = { content: 'MEMBER_WRITE_DENIED' }
    else if (calls.length === 2) delta = tool(`read_${member}_after`, 'read', { file_path: `${member}.json` })
    else {
      assert.ok(JSON.stringify(last?.content).includes(value), 'Member must observe the actual file contents')
      delta = structured(value)
    }
  }
  else if (last?.role === 'user') delta = { tool_calls: [{ index: 0, id: `graph_${requests.length}`, type: 'function', function: {
    name: 'workflow', arguments: JSON.stringify({ architecture, meta: { name: 'architecture-proof', description: 'Combine independent evidence through a reviewer' }, args: { material: 'fixture' } }),
  } }] }
  else delta = { content: 'GRAPH_TASK_COMPLETE' }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const value = { id: 'graph-fixture', object: 'chat.completion.chunk', created: 1, model: 'mimo-v2.6-pro' }
  response.end([
    { ...value, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...value, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
})
function structured(value) {
  return tool(`structured_${requests.length}`, 'structured_output', { value })
}
function tool(id, name, args) {
  return { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/v1`
const patchPath = resolve(project, 'provider-fixture.patch.yml')
await writeFile(patchPath, (await readFile(resolve(root, 'runtime/packages/bundle/nexgent-app/cordis.patch.yml'), 'utf8'))
  .replace('https://token-plan-cn.xiaomimimo.com/v1', endpoint))
async function run(label, sessionId, denied = false) {
  const args = [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--patch', patchPath, '--json']
  if (sessionId) args.push('--session-id', sessionId)
  args.push('--', 'GRAPH_TASK: use the architecture workflow to combine two independent members and a reviewer.')
  const child = spawn(process.execPath, args, { cwd: project, env: { ...process.env,
    DSH_HOME: resolve(project, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF', NEXGENT_API_KEY: 'keyless-fixture',
    ...denied ? { DSH_PERMISSION_MODE: 'read-only' } : {},
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  await writeFile(resolve(project, `${label}.stdout.jsonl`), stdout)
  await writeFile(resolve(project, `${label}.stderr.txt`), stderr)
  assert.equal(timedOut, false, `${label} timed out; inspect ${project}`)
  assert.equal(code, 0, `${label} failed; inspect ${project}`)
  const records = stdout.trim().split('\n').map(line => JSON.parse(line))
  const results = records.filter(record => record.type === 'tool_result').map(record => record.result).join('\n')
  const version = results.match(/"architectureVersion"\s*:\s*"([a-f0-9]{64})"/)?.[1]
  if (denied) {
    assert.equal(version, undefined)
    assert.ok(results.includes('architecture dependency failed'))
    return { pid: child.pid, rejected: true }
  }
  assert.ok(version, `Graph did not execute successfully; inspect ${project}`)
  assert.ok(results.includes('RESULT_A') && results.includes('RESULT_B') && results.includes('RESULT_REVIEW'))
  return { pid: child.pid, version, sessionId: JSON.stringify(records).match(/session-[0-9a-f-]+/)?.[0] }
}
try {
  const first = await run('first')
  assert.ok(first.sessionId)
  const resumed = await run('resumed', first.sessionId)
  assert.equal(first.version, resumed.version)
  assert.notEqual(first.pid, resumed.pid)
  assert.deepEqual(JSON.parse(await readFile(resolve(project, 'a.json'), 'utf8')), { value: 'RESULT_A' })
  assert.deepEqual(JSON.parse(await readFile(resolve(project, 'b.json'), 'utf8')), { value: 'RESULT_B' })
  await writeFile(resolve(project, 'a.json'), 'READ_ONLY_CANARY_A')
  await writeFile(resolve(project, 'b.json'), 'READ_ONLY_CANARY_B')
  const deniedStart = requests.length
  const denied = await run('denied', undefined, true)
  assert.equal(await readFile(resolve(project, 'a.json'), 'utf8'), 'READ_ONLY_CANARY_A')
  assert.equal(await readFile(resolve(project, 'b.json'), 'utf8'), 'READ_ONLY_CANARY_B')
  assert.ok(!requests.slice(deniedStart).some(request => request.max_tokens !== 64 &&
    JSON.stringify(request.messages.findLast(message => message.role === 'user' && !String(message.content).startsWith('Current runtime context.'))?.content).includes('GRAPH_MEMBER_REVIEW')))
  const primary = requests.find(request => request.max_tokens !== 64 && request.tools?.some(tool => tool.function?.name === 'workflow'))
  const system = primary.messages.find(message => message.role === 'system').content
  assert.ok(system.includes('You are Nexgent'))
  assert.ok(!system.includes('You are an AI agent powered by DeepSeek Harness.'))
  const evidence = { passed: true, scope: 'built application, actual member file effects and restart; only external HTTP model mocked',
    policy: 'workspace-write task; read-only coordinator; read-only child denial also verified', architecture, first, resumed, denied, requestCount: requests.length }
  await writeFile(resolve(project, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await writeFile(resolve(project, 'requests.json'), JSON.stringify(requests, null, 2) + '\n')
}
