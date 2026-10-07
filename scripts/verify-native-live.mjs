import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const powershell = process.env.NEXGENT_TEST_PWSH ?? spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]
assert.ok(powershell, 'PowerShell 7 is required')
// Credentials are loaded into the child environment only, never into evidence.
process.loadEnvFile(resolve(root, '.env'))
assert.ok(process.env.NEXGENT_API_KEY, 'NEXGENT_API_KEY is required')
const project = resolve(root, 'validation-workspace', `native-pro-${Date.now()}`)
await mkdir(project, { recursive: true })
await writeFile(resolve(project, 'numbers.csv'), 'value\n3\n7\n11\n')
async function run(task, sessionId, label) {
  const args = ['-NoProfile', '-File', resolve(root, 'run.ps1'), '-Project', project, '-Json']
  if (sessionId) args.push('-SessionId', sessionId)
  args.push(task)
  const child = spawn(powershell, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  const timer = setTimeout(() => child.kill(), 180_000)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  await writeFile(resolve(project, `${label}.stdout.jsonl`), stdout)
  await writeFile(resolve(project, `${label}.stderr.txt`), stderr)
  assert.equal(code, 0, `${label} failed; inspect its saved stdout and stderr`)
  return { pid: child.pid, records: stdout.trim().split('\n').filter(Boolean).map(value => JSON.parse(value)) }
}
const first = await run('Read numbers.csv using the available filesystem tools. Calculate count, sum, and mean. Write summary.json with exactly those numeric fields. Verify the written file by reading it before reporting completion.', undefined, 'delivery')
assert.deepEqual(JSON.parse(await readFile(resolve(project, 'summary.json'), 'utf8')), { count: 3, sum: 21, mean: 7 })
const sessionId = JSON.stringify(first.records).match(/session-[0-9a-f-]+/)?.[0]
assert.ok(sessionId)
const second = await run('Continue the previous task. Read the existing summary.json and original numbers.csv. Add numeric min and max fields to summary.json while preserving the earlier fields. Read the final file to verify it.', sessionId, 'resume')
assert.deepEqual(JSON.parse(await readFile(resolve(project, 'summary.json'), 'utf8')), { count: 3, sum: 21, mean: 7, min: 3, max: 11 })
assert.notEqual(first.pid, second.pid)
const usage = [...first.records, ...second.records].filter(record => record.type === 'status' && record.phase === 'step_end').map(record => record.usage)
const evidence = { passed: true, scope: 'native task delivery and separate-process continuation; no RSI claim',
  provider: 'mimo', model: 'mimo-v2.6-pro', sessionId, firstPid: first.pid, resumedPid: second.pid,
  project, verifiedOutput: JSON.parse(await readFile(resolve(project, 'summary.json'), 'utf8')), usage }
await writeFile(resolve(project, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence))
