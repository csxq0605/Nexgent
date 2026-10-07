// Only the external model is frozen. The shipped app writes source and runs
// actual Node tests through its Windows workspace-write PowerShell executor.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(resolve(root, 'validation-workspace'), { recursive: true })
const evidenceRoot = await mkdtemp(resolve(root, 'validation-workspace/native-code-'))
const expectAclFailure = process.argv.includes('--modify-project')
// The executor needs caller-owned Full-control directories to apply its Low
// integrity label. Allocate an ordinary temp project; do not edit inherited ACLs.
const project = await mkdtemp(resolve(expectAclFailure ? evidenceRoot : tmpdir(), 'nexgent-native-code-'))
const source = `export function normalizeRecords(text) {
  const unique = new Map();
  for (const [index, line] of text.split(/\\r?\\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('Invalid JSON at line ' + (index + 1)); }
    if (!row || typeof row.id !== 'string') throw new Error('Missing id at line ' + (index + 1));
    unique.set(row.id, row);
  }
  return [...unique.values()];
}
`
const tests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords } from './records.mjs';
test('Unicode records and CRLF blanks retain the last duplicate', () => {
  assert.deepEqual(normalizeRecords('{"id":"北","value":1}\\r\\n\\r\\n{"id":"北","value":2}\\r\\n{"id":"南","value":3}'), [{id:'北',value:2},{id:'南',value:3}]);
});
test('malformed JSON reports the source line', () => assert.throws(() => normalizeRecords('\\nnot-json'), /line 2/));
test('missing identities fail explicitly', () => assert.throws(() => normalizeRecords('{}'), /Missing id/));
test('workspace-write execution creates a real artifact', async () => {
  const {writeFile} = await import('node:fs/promises');
  await writeFile('tested-output.json', JSON.stringify(normalizeRecords('{"id":"verified","value":42}')));
});
`
const command = `& '${process.execPath.replaceAll("'", "''")}' --test --test-isolation=none records.test.mjs`
const requests = []
const activeReplies = new Set()
let fixtureError
async function reply(request, response) {
  let body = ''
  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  requests.push(parsed)
  assert.ok(requests.length <= 15, 'Unexpected repeated model request')
  const title = parsed.max_tokens === 64
  const calls = parsed.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])
  const steps = [
    ['write', { file_path: 'records.mjs', content: source }],
    ['write', { file_path: 'records.test.mjs', content: tests }],
    ['pwsh', { command, description: 'Run actual Node tests and create the tested output', timeoutMs: 30000 }],
  ]
  let delta
  if (title) delta = { content: 'Native code proof' }
  else if (calls.length < steps.length) {
    const [name, input] = steps[calls.length]
    delta = { tool_calls: [{ index: 0, id: `code_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }
  } else delta = { content: 'CODE_TASK_COMPLETE' }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const common = { id: 'code-fixture', object: 'chat.completion.chunk', created: 1, model: 'mimo-v2.6-pro' }
  response.end([
    { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
}
const server = createServer((request, response) => {
  const pending = reply(request, response).catch(error => {
    fixtureError ??= error
    if (response.destroyed) return
    if (response.headersSent) { response.destroy(); return }
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: String(error) } }))
  })
  activeReplies.add(pending)
  void pending.then(() => activeReplies.delete(pending))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const patch = resolve(evidenceRoot, 'provider-fixture.patch.yml')
  await writeFile(patch, (await readFile(resolve(root, 'runtime/packages/bundle/nexgent-app/cordis.patch.yml'), 'utf8'))
    .replace('https://token-plan-cn.xiaomimimo.com/v1', `http://127.0.0.1:${server.address().port}/v1`))
  const child = spawn(process.execPath, [resolve(root, 'runtime/apps/cli/lib/bin.js'), '--profile', 'nexgent-run', '--patch', patch, '--json', '--', 'Implement and test a JSONL normalizer using native write and PowerShell tools.'], {
    cwd: project, env: { ...process.env, DSH_HOME: resolve(evidenceRoot, '.nexgent/native'), DSH_TELEMETRY_MODE: 'OFF', NEXGENT_API_KEY: 'keyless-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  await writeFile(resolve(evidenceRoot, 'stdout.jsonl'), stdout)
  await writeFile(resolve(evidenceRoot, 'stderr.txt'), stderr)
  assert.equal(timedOut, false, `Inspect ${evidenceRoot}`)
  assert.equal(code, 0, `Inspect ${evidenceRoot}`)
  assert.equal(fixtureError, undefined)
  const records = stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
  const result = records.find(record => record.type === 'tool_result' && record.callId === 'code_2')
  if (expectAclFailure) {
    assert.ok(result?.result.includes('SetNamedSecurityInfoW') && result.result.includes('WRITE_OWNER'))
    await assert.rejects(readFile(resolve(project, 'tested-output.json')), { code: 'ENOENT' })
    const evidence = { passed: true, scope: 'Modify-only workspace fails with actionable ACL diagnostics, without accepting code delivery',
      pid: child.pid, project, executionRejected: true }
    await writeFile(resolve(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify(evidence))
  } else {
    assert.ok(result && !result.isError, `PowerShell did not complete; inspect ${evidenceRoot}`)
    assert.ok(result.result.includes('pass 4'), `Actual tests did not pass; inspect ${evidenceRoot}`)
    assert.deepEqual(JSON.parse(await readFile(resolve(project, 'tested-output.json'), 'utf8')), [{ id: 'verified', value: 42 }])
    assert.equal(await readFile(resolve(project, 'records.mjs'), 'utf8'), source)
    assert.equal(await readFile(resolve(project, 'records.test.mjs'), 'utf8'), tests)
    await writeFile(resolve(evidenceRoot, 'records.mjs'), source)
    await writeFile(resolve(evidenceRoot, 'records.test.mjs'), tests)
    await writeFile(resolve(evidenceRoot, 'tested-output.json'), await readFile(resolve(project, 'tested-output.json')))
    const evidence = { passed: true, scope: 'built app, actual source writes and confined Node tests; only external model frozen',
      policy: 'default workspace-write; ordinary caller-owned temporary project; no ACL edits by probe', pid: child.pid,
      project, sessionId: records.find(record => record.type === 'session')?.sessionId, testsPassed: 4, output: [{ id: 'verified', value: 42 }] }
    await writeFile(resolve(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify(evidence))
  }
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await Promise.allSettled([...activeReplies])
  await writeFile(resolve(evidenceRoot, 'requests.json'), JSON.stringify(requests, null, 2) + '\n')
}
