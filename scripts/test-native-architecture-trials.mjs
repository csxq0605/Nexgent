import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNativeExecutionLedgers } from './read-native-execution-ledger.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(resolve(root, 'validation-workspace'), { recursive: true })
const project = await mkdtemp(resolve(root, 'validation-workspace/native-output-trial-'))
const graph = mode => ({ nodes: [{ id: 'answer', role: 'solver', prompt: `TRIAL_MEMBER_${mode}: Double input.number and report the value.`,
  dependencies: [], provider: 'mimo', model: 'mimo-v2.6-pro', toolFilter: { allow: ['write'] },
  schema: { type: 'object', additionalProperties: false, properties: { value: { type: 'integer' } }, required: ['value'] } }] })
const plan = { id: 'double', description: 'Frozen structured-output cases', baseline: graph('BASELINE'),
  cases: [{ id: 'first', input: { number: 3 }, outputNode: 'answer', expected: { value: 6 } },
    { id: 'unseen', input: { number: 7 }, outputNode: 'answer', expected: { value: 14 } }] }
const requests = []
const replies = new Set()
let fixtureFailure
let candidateVersion
const server = createServer((request, response) => {
  const pending = respond(request, response).catch(error => {
    fixtureFailure ??= error
    if (response.destroyed) return
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Fixture assertion failed' } }))
  })
  replies.add(pending)
  void pending.then(() => replies.delete(pending))
})
async function respond(request, response) {
  let text = ''
  for await (const chunk of request) text += chunk
  const body = JSON.parse(text)
  requests.push(body)
  assert.ok(requests.length <= 80, 'Unbounded model loop in trial fixture')
  const task = body.messages.findLast(message => message.role === 'user' && !String(message.content).startsWith('Current runtime context.'))
  const last = body.messages.findLast(message => message.role !== 'user' || !String(message.content).startsWith('Current runtime context.'))
  const taskText = typeof task?.content === 'string' ? task.content : JSON.stringify(task?.content)
  let delta
  if (body.max_tokens === 64) delta = { content: 'Native architecture trials' }
  else if (taskText.includes('TRIAL_MEMBER_')) {
    const member = JSON.parse(task.content)
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['structured_output'], 'Trial members must have no global tools')
    assert.ok(!JSON.stringify(body.messages).includes('expected'), 'Host criteria must stay out of candidate prompts')
    if (member.task.includes('ERROR')) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Controlled candidate execution failure' } }))
      return
    }
    const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
    if (member.task.includes('BAD') && calls.length === 0) delta = call('write', { file_path: 'tampered-criteria.json', content: 'must not exist' })
    else {
      if (member.task.includes('BAD')) assert.match(JSON.stringify(last?.content), /unknown tool|not (?:available|found|registered)/i)
      delta = call('structured_output', { value: member.task.includes('BAD') ? 0 : member.input.number * 2 })
    }
  } else if (last?.role === 'user') {
    const mode = taskText.includes('SAVED') ? 'SAVED' : taskText.includes('BAD') ? 'BAD' : taskText.includes('ERROR') ? 'ERROR' : 'GOOD'
    const args = { planId: 'double', ...(mode === 'SAVED' ? { architectureVersion: candidateVersion } : { architecture: graph(mode) }) }
    delta = call('architecture_trial', args)
  } else delta = { content: 'TRIAL_TASK_COMPLETE' }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const header = { id: 'trial-fixture', object: 'chat.completion.chunk', created: 1, model: 'mimo-v2.6-pro' }
  response.end([
    { ...header, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
}
function call(name, args) {
  return { tool_calls: [{ index: 0, id: `trial_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const patch = resolve(project, 'host-plan.patch.yml')
const template = await readFile(resolve(root, 'runtime/packages/bundle/nexgent-app/cordis.patch.yml'), 'utf8')
await writeFile(patch, template.replace('https://token-plan-cn.xiaomimimo.com/v1', `http://127.0.0.1:${server.address().port}/v1`)
  .replace('plans: []', `plans: ${JSON.stringify([plan])}`))

async function run(mode) {
  const child = spawn(process.execPath, [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--patch', patch, '--json', '--',
    `TRIAL_TASK_${mode}: compare the candidate with the host's frozen plan.`], { cwd: project, env: { ...process.env,
    DSH_HOME: resolve(project, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF', NEXGENT_API_KEY: 'keyless-fixture' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  await writeFile(resolve(project, `${mode}.stdout.jsonl`), stdout)
  await writeFile(resolve(project, `${mode}.stderr.txt`), stderr)
  assert.equal(timedOut, false, `Native trial timed out: ${project}`)
  assert.equal(code, 0, `Native trial process failed: ${project}`)
  assert.doesNotMatch(stderr, /failed to import|receipt could not be synchronized|member recording failed/i)
  const records = stdout.trim().split('\n').map(line => JSON.parse(line))
  const results = records.filter(record => record.type === 'tool_result').map(record => record.result).join('\n')
  const version = results.match(/"candidateVersion":"([a-f0-9]{64})"/)?.[1]
  const status = mode === 'BAD' ? 'fail' : mode === 'ERROR' ? 'unknown' : 'pass'
  assert.ok(results.includes(`"status":"${status}"`) && results.includes('"adopted":false'), `Missing ${status} host verdict: ${project}`)
  assert.ok(version)
  return { mode, pid: child.pid, status, version, sessionId: JSON.stringify(records).match(/session-[0-9a-f-]+/)?.[0] }
}
try {
  const runs = []
  runs.push(await run('GOOD'))
  candidateVersion = runs[0].version
  runs.push(await run('BAD'), await run('ERROR'), await run('SAVED'))
  assert.equal(runs[3].version, candidateVersion)
  assert.equal(new Set(runs.map(run => run.pid)).size, 4)
  assert.equal(new Set(runs.map(run => run.sessionId)).size, 4)
  const receiptDirectory = resolve(project, '.nexgent/native/architecture-trials')
  const receipts = await Promise.all((await readdir(receiptDirectory)).map(async file => ({ file,
    records: (await readFile(resolve(receiptDirectory, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) })))
  assert.equal(receipts.length, 4)
  const starts = receipts.map(receipt => receipt.records[0])
  assert.equal(new Set(starts.map(record => record.planDigest)).size, 1)
  assert.equal(new Set(starts.map(record => record.baselineVersion)).size, 1)
  assert.ok(starts.every(record => record.type === 'trial-start' && record.mode === 'output-only'))
  assert.deepEqual(receipts.map(receipt => receipt.records.at(-1).status).sort(), ['fail', 'pass', 'pass', 'unknown'])
  for (const receipt of receipts) {
    assert.equal(receipt.records.at(-1).type, 'trial-end')
    assert.equal(receipt.records.filter(record => record.type === 'case-start').length, 4)
    assert.equal(receipt.records.filter(record => record.type === 'case-end').length, 4)
    assert.equal(receipt.records.filter(record => record.type === 'member-start').length, 4)
    assert.ok(receipt.records.every(record => !Object.hasOwn(record, 'expected')))
  }
  await assert.rejects(readFile(resolve(project, 'tampered-criteria.json')), { code: 'ENOENT' })
  const ledgers = await readNativeExecutionLedgers(resolve(project, '.nexgent/native/execution-ledgers'))
  assert.ok(ledgers.every(ledger => ledger.observationsComplete))
  const observed = ledgers.reduce((count, ledger) => count + ledger.observedRequests, 0)
  assert.equal(observed, requests.length, 'Every endpoint request needs a native observation')
  const sessionIds = new Set(ledgers.flatMap(ledger => ledger.groups.map(group => group.sessionId)))
  for (const receipt of receipts) {
    for (const member of receipt.records.filter(record => record.type === 'member-start')) assert.ok(sessionIds.has(member.childId), 'Trial members must map to actual native requests')
  }
  assert.ifError(fixtureFailure)
  const evidence = { format: 1, project, mode: 'built-native-keyless', runs, requests: requests.length,
    observed, receipts: receipts.map(receipt => ({ file: receipt.file, summary: receipt.records.at(-1) })),
    ledgers: ledgers.map(ledger => ledger), criteriaTamperingDenied: true, automaticAdoption: false }
  await writeFile(resolve(project, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ project, runs, observed, verdicts: evidence.receipts.map(receipt => receipt.summary.status) }, null, 2))
} finally {
  await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([...replies])
}
