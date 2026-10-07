import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNativeExecutionLedgers } from './read-native-execution-ledger.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(resolve(root, 'validation-workspace'), { recursive: true })
const project = await mkdtemp(resolve(root, 'validation-workspace/native-output-adoption-'))
const architectureDirectory = resolve(project, 'architectures')
const activationDirectory = resolve(project, 'activations')
const graph = mode => ({ nodes: [{ id: 'answer', role: 'solver', prompt: `ADOPTION_MEMBER_${mode}: Double input.number and report the value.`,
  dependencies: [], provider: 'mimo', model: 'mimo-v2.6-pro', toolFilter: { allow: ['write'] },
  schema: { type: 'object', additionalProperties: false, properties: { value: { type: 'integer' } }, required: ['value'] } }] })
const selection = { id: 'selection', description: 'Frozen output selection', baseline: graph('BASELINE'),
  cases: [3, 5].map(number => ({ id: `select-${number}`, input: { number }, outputNode: 'answer', expected: { value: number * 2 } })) }
const guard = { ...selection, id: 'guard', description: 'Independent output guard',
  cases: [{ id: 'guard-7', input: { number: 7 }, outputNode: 'answer', expected: { value: 14 } }] }
const policy = { id: 'double', description: 'Double structured numbers', selectionPlanId: 'selection', guardPlanId: 'guard', maxCandidates: 3 }
const requests = [], replies = new Set()
let fixtureFailure, candidateVersion, raceEnabled = false, raceArrivals = 0
const barrier = Promise.withResolvers()
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
  assert.ok(requests.length <= 100, 'Unbounded native adoption loop')
  const task = body.messages.findLast(message => message.role === 'user' && !String(message.content).startsWith('Current runtime context.'))
  const last = body.messages.findLast(message => message.role !== 'user' || !String(message.content).startsWith('Current runtime context.'))
  const taskText = typeof task?.content === 'string' ? task.content : JSON.stringify(task?.content)
  let delta
  if (body.max_tokens === 64) delta = { content: 'Native architecture adoption' }
  else if (taskText.includes('ADOPTION_MEMBER_')) {
    const member = JSON.parse(task.content)
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['structured_output'])
    assert.ok(!JSON.stringify(body.messages).includes('expected'))
    if (raceEnabled && member.task.includes('BASELINE') && member.input.number === 3) {
      if (++raceArrivals === 2) barrier.resolve()
      await barrier.promise
    }
    if (member.input.number === 99) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Controlled accepted execution failure' } }))
      return
    }
    const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
    if (!member.task.includes('BASELINE') && calls.length === 0) delta = call('write', { file_path: 'tampered-policy.json', content: 'must not exist' })
    else {
      if (!member.task.includes('BASELINE')) assert.match(JSON.stringify(last?.content), /unknown tool|not (?:available|found|registered)/i)
      const bad = member.task.includes('BASELINE') || member.task.includes('GUARD_BAD') && member.input.number === 7
      delta = call('structured_output', { value: bad ? 0 : member.input.number * 2 })
    }
  } else if (last?.role === 'user') {
    assert.ok(body.tools.some(tool => tool.function.name === 'architecture_run'))
    assert.ok(body.tools.some(tool => tool.function.name === 'architecture_adopt'))
    assert.ok(!body.tools.some(tool => tool.function.name === 'architecture_trial'), 'Reserved cases cannot be sampled as exploratory trials')
    const mode = taskText.match(/ADOPTION_TASK_([A-Z_]+)/)?.[1]
    if (mode === 'GUARD_BAD' || mode?.startsWith('RACE_')) delta = call('architecture_adopt', { policyId: 'double', architecture: graph(mode) })
    else if (mode === 'REPLAY') delta = call('architecture_adopt', { policyId: 'double', architectureVersion: candidateVersion })
    else delta = call('architecture_run', { policyId: 'double', input: { number: mode === 'FAILURE' ? 99 : 11 } })
  } else delta = { content: 'ADOPTION_TASK_COMPLETE' }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const header = { id: 'adoption-fixture', object: 'chat.completion.chunk', created: 1, model: 'mimo-v2.6-pro' }
  response.end([
    { ...header, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
}
function call(name, args) {
  return { tool_calls: [{ index: 0, id: `adopt_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const template = await readFile(resolve(root, 'runtime/packages/bundle/nexgent-app/cordis.patch.yml'), 'utf8')
const runs = []
async function run(mode) {
  const home = resolve(project, 'homes', mode)
  const patch = resolve(project, `${mode}.patch.yml`)
  await writeFile(patch, template.replace('https://token-plan-cn.xiaomimimo.com/v1', `http://127.0.0.1:${server.address().port}/v1`)
    .replace("architectureDirectory: !!js dshHomePath('architectures')", `architectureDirectory: ${JSON.stringify(architectureDirectory)}`)
    .replace('plans: []', `maxCaseMs: 15000\n        activationDirectory: ${JSON.stringify(activationDirectory)}\n        policies: ${JSON.stringify([policy])}\n        plans: ${JSON.stringify([selection, guard])}`))
  const child = spawn(process.execPath, [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--patch', patch, '--json', '--',
    `ADOPTION_TASK_${mode}: use the host's configured output policy.`], { cwd: project, env: { ...process.env,
    DSH_HOME: home, DSH_TELEMETRY_MODE: 'OFF', NEXGENT_API_KEY: 'keyless-fixture' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  // Six 15-second cases plus startup and quiescent cleanup must fit inside the fixture deadline.
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 180_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  await writeFile(resolve(project, `${mode}.stdout.jsonl`), stdout)
  await writeFile(resolve(project, `${mode}.stderr.txt`), stderr)
  assert.equal(timedOut, false, `Native adoption timeout: ${project}`)
  assert.equal(code, 0, `Native adoption process failed: ${project}`)
  assert.doesNotMatch(stderr, /failed to import|receipt could not be synchronized|member recording failed/i)
  const records = stdout.trim().split('\n').map(line => JSON.parse(line))
  const resultText = records.filter(record => record.type === 'tool_result').map(record => record.result).join('\n')
  const values = resultText.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const result = values.find(value => value.policyId === 'double')
  const output = { mode, pid: child.pid, home, sessionId: JSON.stringify(records).match(/session-[0-9a-f-]+/)?.[0], result, resultText }
  runs.push(output)
  return output
}
try {
  const rejected = await run('GUARD_BAD')
  assert.equal(rejected.result?.reason, 'guard-not-passed')
  assert.equal(rejected.result?.adopted, false)
  raceEnabled = true
  const race = await Promise.all([run('RACE_FIRST'), run('RACE_SECOND')])
  raceEnabled = false
  assert.equal(raceArrivals, 2, 'Both native processes must have observed baseline before either commits')
  const winner = race.find(run => run.result?.adopted)
  assert.ok(winner)
  assert.equal(race.filter(run => run.result?.adopted).length, 1)
  assert.equal(race.find(run => !run.result?.adopted)?.result?.reason, 'activation-conflict')
  candidateVersion = winner.result.candidateVersion
  const reuse = await run('REUSE')
  assert.equal(reuse.result?.architectureVersion, candidateVersion)
  assert.deepEqual(reuse.result?.output, { value: 22 })
  assert.equal(reuse.result?.activationRevision, 1)
  const failure = await run('FAILURE')
  assert.equal(failure.result?.status, 'unknown')
  assert.equal(failure.result?.rolledBack, true)
  const after = await run('AFTER_ROLLBACK')
  assert.equal(after.result?.activationRevision, 2)
  assert.deepEqual(after.result?.output, { value: 0 })
  const beforeReplay = requests.length
  const replay = await run('REPLAY')
  assert.match(replay.resultText, /already attempted/)
  assert.equal(requests.length - beforeReplay, 3, 'Rejected replay has only title and parent requests')
  assert.equal(new Set(runs.map(run => run.pid)).size, 7)
  assert.equal(new Set(runs.map(run => run.sessionId)).size, 7)
  await assert.rejects(readFile(resolve(project, 'tampered-policy.json')), { code: 'ENOENT' })
  const ledgers = (await Promise.all(runs.map(run => readNativeExecutionLedgers(resolve(run.home, 'execution-ledgers'))))).flat()
  assert.ok(ledgers.every(ledger => ledger.observationsComplete))
  const observed = ledgers.reduce((count, ledger) => count + ledger.observedRequests, 0)
  assert.equal(observed, requests.length)
  const sessionIds = new Set(ledgers.flatMap(ledger => ledger.groups.map(group => group.sessionId)))
  for (const run of runs.filter(run => ['REUSE', 'FAILURE', 'AFTER_ROLLBACK'].includes(run.mode))) {
    assert.equal(run.result.members.length, 1)
    assert.ok(sessionIds.has(run.result.members[0].childId), 'Accepted task members must map to native requests')
  }
  assert.ifError(fixtureFailure)
  const policyDirectory = resolve(activationDirectory, winner.result.policyDigest)
  const revisions = await Promise.all((await readdir(policyDirectory)).filter(file => /^\d+\.json$/.test(file))
    .sort().map(async file => JSON.parse(await readFile(resolve(policyDirectory, file), 'utf8'))))
  assert.deepEqual(revisions.map(revision => revision.type), ['adopt', 'rollback'])
  const evidence = { format: 1, project, mode: 'built-native-keyless', frozen: { selection, guard, policy }, runs,
    revisions, requests: requests.length, observed, ledgers, concurrentNativeSelection: true, criteriaTamperingDenied: true,
    automaticVersionResolution: true, normalTaskQualityScored: false, realModelImprovementClaimed: false }
  await writeFile(resolve(project, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ project, observed, runs: runs.map(({ resultText, ...run }) => run), revisions }, null, 2))
} finally {
  barrier.resolve()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([...replies])
}
