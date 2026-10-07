// Actual-model coding delivery, checked by a host-authored acceptance file.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from '../runtime/packages/session/session-persistence-jsonl/lib/types/zstd.js'

const root = fileURLToPath(new URL('../', import.meta.url))
process.loadEnvFile(resolve(root, '.env'))
assert.ok(process.env.NEXGENT_API_KEY, 'NEXGENT_API_KEY is required')
await mkdir(resolve(root, 'validation-workspace'), { recursive: true })
const graphMode = process.argv.includes('--architecture')
const evidenceRoot = await mkdtemp(resolve(root, graphMode ? 'validation-workspace/native-graph-code-pro-' : 'validation-workspace/native-code-pro-'))
const project = await mkdtemp(resolve(tmpdir(), 'nexgent-native-code-pro-'))
const acceptance = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {normalizeRecords} from './records.mjs';
test('Unicode, CRLF and duplicate ids', () => assert.deepEqual(normalizeRecords('{"id":"北","value":1}\\r\\n\\r\\n{"id":"北","value":2}\\r\\n{"id":"南","value":3}'), [{id:'北',value:2},{id:'南',value:3}]));
test('malformed input reports physical line', () => assert.throws(() => normalizeRecords('\\nnot-json'), /line 2/));
test('missing identity fails', () => assert.throws(() => normalizeRecords('{}'), /Missing id.*line 1/));
test('empty input is empty', () => assert.deepEqual(normalizeRecords('  \\r\\n'), []));
test('real output artifact from actual implementation', async () => await writeFile('tested-output.json', JSON.stringify(normalizeRecords('{"id":"verified","value":42}'))));
`
await writeFile(resolve(project, 'acceptance.test.mjs'), acceptance)
// Forward slashes avoid nested JSON/backslash ambiguity when the parent copies a graph.
const executable = graphMode ? process.execPath.replaceAll('\\', '/') : process.execPath
const command = `& '${executable.replaceAll("'", "''")}' --test --test-isolation=none acceptance.test.mjs`
const implementationTask = `Create records.mjs exporting normalizeRecords(text). It accepts JSONL, ignores blank lines, accepts CRLF, and keeps only the last record for each string id. Preserve first-seen id order. Invalid JSON must throw an Error containing "Invalid JSON at line N" (physical 1-based line); absent or non-string id must throw "Missing id at line N". Empty input returns []. Read the existing host-authored acceptance.test.mjs but preserve it byte for byte. Implement the general function using native filesystem tools, then run the exact PowerShell command ${JSON.stringify(command)} with the native pwsh tool. Resolve actual failures and verify tested-output.json before reporting completion.`
function objectSchema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}
const architecture = { nodes: [
  { id: 'builder', role: 'implementer', prompt: `${implementationTask} Report testsPassed through structured_output after the actual test run.`, dependencies: [],
    persona: 'You are Nexgent. Implement and test the requested program in {{cwd}}.', toolFilter: { allow: ['pwsh', 'read', 'write'] },
    schema: objectSchema({ testsPassed: { type: 'number' } }) },
  { id: 'review', role: 'reviewer', prompt: 'Read acceptance.test.mjs, records.mjs and tested-output.json. Check the code against the actual public requirements and the output against [{"id":"verified","value":42}]. The dependency must report five passing tests. You have read access only. Report verified true through structured_output only when all checks agree; otherwise false.', dependencies: ['builder'],
    persona: 'You are Nexgent. Review the delivered code and files in {{cwd}}.', toolFilter: { allow: ['read'] },
    schema: objectSchema({ verified: { type: 'boolean' } }) },
] }
const task = graphMode
  ? `Run exactly this architecture through workflow, with meta name code-delivery and description Implement and review JSONL normalization. Do not modify the graph, do not do the member work yourself, and do not start additional members. Graph: ${JSON.stringify(architecture)}`
  : `${implementationTask} Do not delegate or use a workflow for this small task.`
const child = spawn(process.execPath, [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--json', '--', task], {
  cwd: project, env: { ...process.env, DSH_HOME: resolve(evidenceRoot, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '', stderr = '', timedOut = false
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
const timer = setTimeout(() => { timedOut = true; child.kill() }, 180_000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
await writeFile(resolve(evidenceRoot, 'stdout.jsonl'), stdout)
await writeFile(resolve(evidenceRoot, 'stderr.txt'), stderr)
assert.equal(timedOut, false, `Inspect ${evidenceRoot}`)
assert.equal(code, 0, `Inspect ${evidenceRoot}`)
const records = stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
const sessionId = records.find(record => record.type === 'session')?.sessionId
let graphResult, members
let toolRecords = records
if (graphMode) {
  const graphCall = records.find(record => record.type === 'tool_call' && record.tool === 'workflow')
  assert.deepEqual(graphCall?.input?.architecture, architecture)
  const result = records.find(record => record.type === 'tool_result' && record.callId === graphCall.callId)
  assert.ok(result && !result.isError, `Graph failed; inspect ${evidenceRoot}`)
  graphResult = JSON.parse(result.result.split('Return value:\n')[1])
  assert.deepEqual(graphResult.outputs, { builder: { testsPassed: 5 }, review: { verified: true } })
  const directory = resolve(evidenceRoot, '.nexgent/native/sessions')
  const files = await readdir(directory, { recursive: true })
  const sessions = new Map()
  for (const file of files.filter(file => file.endsWith('/session.v4.jsonl.zstd') || file.endsWith('\\session.v4.jsonl.zstd'))) {
    const compressed = await readFile(resolve(directory, file))
    const scan = scanZstdFrames(compressed)
    assert.equal(scan.tornStart, undefined, 'Closed native history must have no incomplete frame')
    const text = Buffer.concat(scan.frames.map(frame => zstdDecompressSync(compressed.subarray(frame.start, frame.end)))).toString('utf8')
    const events = text.split('\n').filter(Boolean).map(JSON.parse)
    sessions.set(events[0].id, events)
  }
  const parent = sessions.get(sessionId)
  assert.ok(parent, `Missing durable parent history; inspect ${evidenceRoot}`)
  members = parent.filter(event => event.type === 'tool-workflow/agent-start').map(event => event.data)
  assert.deepEqual(members.map(member => member.label).sort(), ['builder', 'review'])
  const builder = sessions.get(members.find(member => member.label === 'builder').childId)
  const reviewer = sessions.get(members.find(member => member.label === 'review').childId)
  assert.ok(builder && reviewer, 'Both member histories must persist')
  const reads = reviewer.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, input: JSON.parse(event.data.arguments) }))
  assert.ok(reads.every(call => call.name === 'read' || call.name === 'structured_output'))
  for (const path of ['records.mjs', 'acceptance.test.mjs', 'tested-output.json']) {
    assert.ok(reads.some(call => call.name === 'read' && call.input.file_path.replaceAll('\\', '/').endsWith(path)), `Reviewer did not read ${path}`)
  }
  toolRecords = builder.flatMap(event => event.type === 'tool/call'
    ? [{ type: 'tool_call', tool: event.data.name, callId: event.data.callId, input: JSON.parse(event.data.arguments) }]
    : event.type === 'tool/result' ? [{ type: 'tool_result', callId: event.data.message.toolCallId,
      isError: event.data.message.isError, result: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }] : [])
}
const call = toolRecords.findLast(record => record.type === 'tool_call' && record.tool === 'pwsh' && record.input.command === command)
assert.ok(call, `Actual code was not tested through the required native executor; inspect ${evidenceRoot}`)
const result = toolRecords.find(record => record.type === 'tool_result' && record.callId === call.callId)
// Native PowerShell omits the exit marker for code 0 and renders every nonzero code.
assert.ok(result && !result.isError && result.result.includes('pass 5') && result.result.includes('fail 0')
  && !result.result.includes('[exit code:'), `Acceptance failed; inspect ${evidenceRoot}`)
assert.equal(await readFile(resolve(project, 'acceptance.test.mjs'), 'utf8'), acceptance)
assert.deepEqual(JSON.parse(await readFile(resolve(project, 'tested-output.json'), 'utf8')), [{ id: 'verified', value: 42 }])
const source = await readFile(resolve(project, 'records.mjs'), 'utf8')
assert.ok(source.includes('normalizeRecords'))
await writeFile(resolve(evidenceRoot, 'records.mjs'), source)
await writeFile(resolve(evidenceRoot, 'acceptance.test.mjs'), acceptance)
await writeFile(resolve(evidenceRoot, 'tested-output.json'), await readFile(resolve(project, 'tested-output.json')))
const evidence = { passed: true, scope: graphMode ? 'actual MiMo graph code delivery, native per-child composition and persisted execution, public acceptance; no adoption or RSI claim' : 'actual MiMo source delivery, host-authored public acceptance checks and confined execution; no RSI claim',
  provider: 'mimo', model: 'mimo-v2.6-pro', policy: 'default workspace-write, normal caller-owned temporary project, tests execute in one confined Node process',
  pid: child.pid, project, sessionId, testsPassed: 5,
  ...graphMode ? { architecture, architectureVersion: graphResult.architectureVersion, outputs: graphResult.outputs, members } : {},
  output: [{ id: 'verified', value: 42 }], mainUsage: records.filter(record => record.phase === 'step_end').map(record => record.usage) }
await writeFile(resolve(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence))
