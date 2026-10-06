// Actual-model coding delivery, checked by a host-authored acceptance file.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.loadEnvFile(resolve(root, '.env'))
assert.ok(process.env.NEXGENT_API_KEY, 'NEXGENT_API_KEY is required')
await mkdir(resolve(root, 'validation-workspace'), { recursive: true })
const evidenceRoot = await mkdtemp(resolve(root, 'validation-workspace/native-code-pro-'))
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
const command = `& '${process.execPath.replaceAll("'", "''")}' --test --test-isolation=none acceptance.test.mjs`
const task = `Create records.mjs exporting normalizeRecords(text). It accepts JSONL, ignores blank lines, accepts CRLF, and keeps only the last record for each string id. Preserve first-seen id order. Invalid JSON must throw an Error containing "Invalid JSON at line N" (physical 1-based line); absent or non-string id must throw "Missing id at line N". Empty input returns []. Read the existing host-authored acceptance.test.mjs but preserve it byte for byte. Implement the general function using native filesystem tools, then run the exact PowerShell command ${JSON.stringify(command)} with the native pwsh tool. Resolve actual failures and verify tested-output.json before reporting completion. Do not delegate or use a workflow for this small task.`
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
const call = records.findLast(record => record.type === 'tool_call' && record.tool === 'pwsh' && record.input.command === command)
assert.ok(call, `Actual code was not tested through the required native executor; inspect ${evidenceRoot}`)
const result = records.find(record => record.type === 'tool_result' && record.callId === call.callId)
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
const evidence = { passed: true, scope: 'actual MiMo source delivery, host-authored public acceptance checks and confined execution; no RSI claim',
  provider: 'mimo', model: 'mimo-v2.6-pro', policy: 'default workspace-write, normal caller-owned temporary project, tests execute in one confined Node process',
  pid: child.pid, project, sessionId: records.find(record => record.type === 'session')?.sessionId, testsPassed: 5,
  output: [{ id: 'verified', value: 42 }], mainUsage: records.filter(record => record.phase === 'step_end').map(record => record.usage) }
await writeFile(resolve(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence))
