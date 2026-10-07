import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from '../runtime/packages/session/session-persistence-jsonl/lib/types/zstd.js'
import { readNativeExecutionLedgers } from './read-native-execution-ledger.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const inspectAt = process.argv.indexOf('--inspect')
const existing = inspectAt < 0 ? undefined : resolve(process.argv[inspectAt + 1])
await mkdir(resolve(root, 'validation-workspace'), { recursive: true })
const evidenceRoot = existing ?? await mkdtemp(resolve(root, 'validation-workspace/native-output-trial-pro-'))
const project = existing ? JSON.parse((await readFile(resolve(existing, 'stdout.jsonl'), 'utf8')).split('\n')[0]).cwd : await mkdtemp(resolve(tmpdir(), 'nexgent-native-output-trial-'))
const schema = { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' } }, required: ['ids', 'count'] }
const baseline = { nodes: [{ id: 'answer', role: 'processor', prompt: 'From input.records, return the distinct string ids in first-seen order and their count. Use structured_output.', dependencies: [], schema }] }
const candidate = { nodes: [{ id: 'answer', role: 'processor', prompt: 'Read every record in input.records. Keep each string id once, in order of its first occurrence. Report ids and count through structured_output, without inventing additional ids.',
  persona: 'You are Nexgent. Compute the requested JSON result from the supplied input.', dependencies: [], schema }] }
const plan = { id: 'ordered-identities', description: 'Host-frozen output-only identity processing', baseline,
  cases: [{ id: 'duplicates', input: { records: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }, outputNode: 'answer', expected: { ids: ['b', 'a'], count: 2 } },
    { id: 'unicode', input: { records: [{ id: '北' }, { id: '南' }, { id: '北' }, { id: '东' }] }, outputNode: 'answer', expected: { ids: ['北', '南', '东'], count: 3 } }] }
let pid, stdout, stderr
if (existing === undefined) {
process.loadEnvFile(resolve(root, '.env'))
assert.ok(process.env.NEXGENT_API_KEY, 'NEXGENT_API_KEY is required')
const patch = resolve(evidenceRoot, 'host-plan.patch.yml')
await writeFile(patch, (await readFile(resolve(root, 'runtime/packages/bundle/nexgent-app/cordis.patch.yml'), 'utf8')).replace('plans: []', `plans: ${JSON.stringify([plan])}`))
const child = spawn(process.execPath, [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--patch', patch, '--json', '--',
  `Call architecture_trial exactly once with planId ordered-identities and exactly this candidate architecture: ${JSON.stringify(candidate)}. Preserve this graph. Do not perform the member work yourself or launch other workflows. Report the actual host trial result; a pass does not adopt a version.`],
{ cwd: project, env: { ...process.env, DSH_HOME: resolve(evidenceRoot, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF' }, stdio: ['ignore', 'pipe', 'pipe'] })
stdout = ''; stderr = ''; let timedOut = false
pid = child.pid
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
const timer = setTimeout(() => { timedOut = true; child.kill() }, 360_000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
await writeFile(resolve(evidenceRoot, 'stdout.jsonl'), stdout)
await writeFile(resolve(evidenceRoot, 'stderr.txt'), stderr)
assert.equal(timedOut, false, `Inspect ${evidenceRoot}`)
assert.equal(code, 0, `Inspect ${evidenceRoot}`)
} else {
stdout = await readFile(resolve(evidenceRoot, 'stdout.jsonl'), 'utf8')
stderr = await readFile(resolve(evidenceRoot, 'stderr.txt'), 'utf8')
}
assert.doesNotMatch(stderr, /failed to import|receipt could not be synchronized|member recording failed/i)
const output = stdout.trim().split('\n').map(line => JSON.parse(line))
const calls = output.filter(record => record.type === 'tool_call' && record.tool === 'architecture_trial')
assert.equal(calls.length, 1)
assert.deepEqual(calls[0].input, { planId: plan.id, architecture: candidate })
const delivered = output.find(record => record.type === 'tool_result' && record.callId === calls[0].callId)
assert.ok(delivered && !delivered.isError)
const summary = JSON.parse(delivered.result)
assert.equal(summary.casesPerArm, 2)
assert.equal(summary.results.length, 4)
assert.equal(summary.adopted, false)
const receiptPath = resolve(evidenceRoot, '.nexgent/native/architecture-trials', `${summary.trialId}.jsonl`)
const receipt = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
assert.equal(receipt.at(-1).type, 'trial-end')
for (const result of summary.results) {
  const actual = receipt.find(record => record.type === 'case-output' && record.arm === result.arm && record.caseId === result.caseId)
  if (result.status === 'unknown') assert.equal(actual, undefined, 'Unknown member output must not become an accepted result')
  else {
    assert.ok(actual)
    const expected = plan.cases.find(item => item.id === result.caseId).expected
    assert.equal(result.status, isDeepStrictEqual(actual.actual, expected) ? 'pass' : 'fail')
  }
}
const verdict = summary.results.some(item => item.status === 'unknown') ? 'unknown' : summary.results.some(item => item.arm === 'candidate' && item.status === 'fail') ? 'fail' : 'pass'
assert.equal(summary.status, verdict)
assert.equal(summary.baselinePassed, summary.results.filter(item => item.arm === 'baseline' && item.status === 'pass').length)
assert.equal(summary.candidatePassed, summary.results.filter(item => item.arm === 'candidate' && item.status === 'pass').length)
const members = receipt.filter(record => record.type === 'member-start')
assert.equal(new Set(members.map(member => member.childId)).size, 4)
const directory = resolve(evidenceRoot, '.nexgent/native/sessions')
const histories = new Map()
for (const file of (await readdir(directory, { recursive: true })).filter(file => /[/\\]session\.v4\.jsonl\.zstd$/.test(file))) {
  const compressed = await readFile(resolve(directory, file))
  const scan = scanZstdFrames(compressed)
  assert.equal(scan.tornStart, undefined)
  const events = Buffer.concat(scan.frames.map(frame => zstdDecompressSync(compressed.subarray(frame.start, frame.end)))).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  histories.set(events[0].id, events)
}
for (const member of members) {
  const events = histories.get(member.childId)
  assert.ok(events, 'Each member needs a durable native session')
  const memberCalls = events.filter(event => event.type === 'tool/call')
  const result = summary.results.find(item => item.runId === member.runId)
  assert.equal(memberCalls.length, result.status === 'unknown' ? 0 : 1)
  assert.ok(memberCalls.every(call => call.data.name === 'structured_output'))
}
const ledgers = await readNativeExecutionLedgers(resolve(evidenceRoot, '.nexgent/native/execution-ledgers'))
assert.ok(ledgers.every(ledger => ledger.observationsComplete))
assert.ok(members.every(member => ledgers.some(ledger => ledger.groups.some(group => group.sessionId === member.childId))))
const evidence = { format: 1, evidenceRoot, project, pid: pid ?? null, provider: 'mimo', model: 'mimo-v2.6-pro', summary, members,
  observedRequests: ledgers.reduce((sum, ledger) => sum + ledger.observedRequests, 0), ledgers,
  limitations: ['Frozen public output cases, not independent selection or hidden holdout.', 'No adoption, code artifact trial, invoice or relative improvement claim.'] }
await writeFile(resolve(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ evidenceRoot, pid: pid ?? null, summary, observedRequests: evidence.observedRequests }, null, 2))
