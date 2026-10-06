import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.loadEnvFile(resolve(root, '.env'))
assert.ok(process.env.NEXGENT_API_KEY, 'NEXGENT_API_KEY is required')
const parent = resolve(root, 'validation-workspace')
await mkdir(parent, { recursive: true })
const project = await mkdtemp(resolve(parent, 'native-architecture-pro-'))
function schema(fields) {
  return { type: 'object', additionalProperties: false, properties: Object.fromEntries(fields.map(field => [field, { type: 'number' }])), required: fields }
}
const architecture = { nodes: [
  { id: 'totals', role: 'analyst', prompt: 'For input.values, compute numeric count and sum. Use the native write tool to save exactly these fields in totals.json. Read the file with the read tool to verify it before reporting the structured result.', dependencies: [], provider: 'mimo', model: 'mimo-v2.6-pro', schema: schema(['count', 'sum']) },
  { id: 'range', role: 'analyst', prompt: 'For input.values, compute numeric mean, min, and max. Use the native write tool to save exactly these fields in range.json. Read the file with the read tool to verify it before reporting the structured result.', dependencies: [], provider: 'mimo', model: 'mimo-v2.6-pro', schema: schema(['mean', 'min', 'max']) },
  { id: 'review', role: 'reviewer', prompt: 'Check the two dependency outputs against input.values. Use native read tools to verify totals.json and range.json. Write review.json with exactly the merged numeric count, sum, mean, min, and max using the write tool. Read review.json before reporting the structured result.', dependencies: ['totals', 'range'], provider: 'mimo', model: 'mimo-v2.6-pro', schema: schema(['count', 'sum', 'mean', 'min', 'max']) },
] }
const task = `Execute exactly this graph through the workflow tool's architecture parameter, not script. Use meta name numeric-review and description Independent totals and range with a review. Set args to {"values":[3,7,11]}. Do not delegate any additional work. Graph: ${JSON.stringify(architecture)}`
const child = spawn(process.execPath, [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--json', '--', task], {
  cwd: project, env: { ...process.env, DSH_HOME: resolve(project, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '', stderr = '', timedOut = false
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
const timer = setTimeout(() => { timedOut = true; child.kill() }, 180_000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
await writeFile(resolve(project, 'stdout.jsonl'), stdout)
await writeFile(resolve(project, 'stderr.txt'), stderr)
assert.equal(timedOut, false, `Graph timed out; inspect ${project}`)
assert.equal(code, 0, `Native app failed; inspect ${project}`)
const records = stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
const call = records.find(record => record.type === 'tool_call' && record.tool === 'workflow')
assert.deepEqual(call?.input?.architecture, architecture)
const result = records.find(record => record.type === 'tool_result' && record.callId === call.callId)
assert.ok(result && !result.isError, `Graph did not complete; inspect ${project}`)
const value = JSON.parse(result.result.split('Return value:\n')[1])
assert.match(value.architectureVersion, /^[a-f0-9]{64}$/)
assert.deepEqual(value.outputs.totals, { count: 3, sum: 21 })
assert.deepEqual(value.outputs.range, { mean: 7, min: 3, max: 11 })
assert.deepEqual(value.outputs.review, { count: 3, sum: 21, mean: 7, min: 3, max: 11 })
for (const [name, output] of Object.entries(value.outputs)) {
  assert.deepEqual(JSON.parse(await readFile(resolve(project, `${name}.json`), 'utf8')), output)
}
const evidence = { passed: true, scope: 'actual MiMo graph execution and independently checked member outputs; no adoption or RSI claim',
  provider: 'mimo', model: 'mimo-v2.6-pro', policy: 'workspace-write task; read-only coordinator', pid: child.pid,
  sessionId: records.find(record => record.type === 'session')?.sessionId, architectureVersion: value.architectureVersion,
  outputs: value.outputs, mainUsage: records.filter(record => record.phase === 'step_end').map(record => record.usage) }
await writeFile(resolve(project, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence))
