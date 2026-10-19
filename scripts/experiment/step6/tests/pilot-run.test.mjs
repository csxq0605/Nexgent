import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanEnv } from '../code.mjs'
import { loadPackages } from '../run.mjs'
import { judgePilotCase, pilotCases } from '../pilot/cases.mjs'
import { listFiles, writeFiles } from '../pilot/common.mjs'
import { MEMORY_POLICY } from '../pilot/memory.mjs'
import { buildPilotReport, validatePilotRecords } from '../pilot/report.mjs'
import { adoptMemoryPolicy, keepOutputs, parsePilotArgs, pilotRawRecords } from '../pilot/run.mjs'
import { applyCall, endState } from '../pilot/scripted-model.mjs'

const RUN = fileURLToPath(new URL('../pilot/run.mjs', import.meta.url))
const cases = pilotCases()
const byId = (/** @type {string} */ id) => /** @type {import('../pilot/common.mjs').PilotCase} */ (cases.find(c => c.id === id))

test('pilot arguments: a backend and --out are required; families are the pilot\'s; no key → exit 2, nothing run', async () => {
  assert.deepEqual(parsePilotArgs(['--scripted', '--out', 'x']).problems, [])
  assert.match(parsePilotArgs([]).problems.join('\n'), /choose --scripted or --real/)
  assert.match(parsePilotArgs(['--real', '--scripted', '--out', 'x']).problems.join('\n'), /exclude/)
  assert.match(parsePilotArgs(['--scripted', '--out', 'x', '--families', 'tables']).problems.join('\n'), /unknown family tables/)
  const dir = await mkdtemp(join(tmpdir(), 'nx6-pr-'))
  try {
    const env = { ...cleanEnv() }
    delete env.NEXGENT_API_KEY
    delete env.ANTHROPIC_API_KEY
    const run = spawnSync(process.execPath, [RUN, '--real', '--out', join(dir, 'out')], { env, encoding: 'utf8' })
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, /no model key/)
    assert.deepEqual(await listFiles(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scripted model: one shell call puts a case\'s end state into the project, binary files and removals included', { skip: process.platform === 'win32' ? 'bash command' : false }, async () => {
  for (const id of ['files/dev/rename-archive-f-102', 'files/holdout/cleanup-archive-f-108', 'files/dev/merge-csv-f-101', 'docs/dev/minutes-d-201']) {
    const task = byId(id)
    for (const convention of [true, false]) {
      const dir = await mkdtemp(join(tmpdir(), 'nx6-sm-'))
      try {
        await writeFiles(dir, task.files)
        const call = applyCall(endState(task, convention))
        assert.equal(call.name, 'bash')
        const run = spawnSync('bash', ['-c', call.arguments.command], { cwd: dir, encoding: 'utf8' })
        assert.equal(run.status, 0, run.stderr)
        const judged = await judgePilotCase(task, dir)
        const checked = judged.points.filter(p => p.by === 'check')
        assert.deepEqual(checked.filter(p => p.pass !== true).map(p => p.id), convention ? [] : ['c'], `${id} convention=${convention}`)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
})

/** Raw records as pilot/run.mjs writes them, built from a few observations. */
function sampleRaw() {
  const run = (/** @type {string} */ arm, /** @type {string} */ caseId, /** @type {number} */ repeat, /** @type {number} */ rate) => ({
    runId: `${arm}#${caseId}#${repeat}`, family: 'docs', caseId, arm, repeat, costUsd: 0.1, componentsUsed: [], capabilityVersions: [arm === 'memory' ? 'm'.repeat(64) : 'baseline'], followUp: arm === 'base' && repeat === 1, turn: 'completed',
    judged: { rate, pass: rate === 1, points: [{ id: 'c', type: 'convention', by: 'check', pass: rate === 1 }, { id: 'r', type: 'wrong-result', by: 'review', pass: true, unclear: arm === 'parent' && repeat === 2 }], problems: [] },
  })
  const runs = []
  for (const caseId of ['docs/holdout/a', 'docs/holdout/b']) for (const repeat of [1, 2, 3]) runs.push(run('base', caseId, repeat, 0.5), run('memory', caseId, repeat, 1), run('parent', caseId, repeat, repeat === 3 ? 0.5 : 1))
  const family = {
    family: 'docs', tasks: { 'docs/dev/x': { set: 'dev', primary: 'c', feedback: [{ rating: 2, comment: '文末没有列出用到的资料文件。' }] } },
    jobs: [{ caseId: 'docs/dev/x', jobId: 'id', status: 'adopted', improverVersion: 'v0', history: ['queued', 'adopted'] }], approvals: [],
    arms: { base: { home: '/o/homes/docs-base', capabilityVersion: 'baseline', improverVersion: 'v0' }, memory: { home: '/o/homes/docs-memory', capabilityVersion: 'm'.repeat(64), improverVersion: 'v0' }, parent: { home: '/o/homes/docs-parent', capabilityVersion: 'p'.repeat(64), improverVersion: 'v0' } },
    memory: { version: 'm'.repeat(64), digest: 'd'.repeat(64), entries: 3, kept: 3, dropped: 0, bytes: 100 },
    runs, agreement: [{ runId: 'x', pointId: 'r', external: true, inLoop: false }, { runId: 'y', pointId: 'r', external: true, inLoop: true }],
    pairs: [{ caseId: 'docs/holdout/a', first: 'parent', second: 'memory', ab: 'tie', ba: 'tie' }],
    components: { base: { components: [], literal: { components: 0, withLiterals: 0, rate: null } }, memory: { components: [{ kind: 'context-policy', name: 'project-notes', class: 'convention-or-fact' }], literal: { components: 1, withLiterals: 0, rate: 0 } }, parent: { components: [{ kind: 'skill', name: 's', class: 'way-of-working' }], literal: { components: 1, withLiterals: 1, rate: 1 } } },
    costs: [{ kind: 'holdout', family: 'docs', ref: 'r', usd: 0.1 }, { kind: 'improvement', family: 'docs', ref: 'j', usd: null }], notes: ['n'], checks: { epoch: 'e', isolation: { leaks: [], scanned: 9, skipped: 0 } },
  }
  const refs = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => ({ id, caseId: 'docs/dev/x', flaw: 'f', ab: i === 5 ? 'B' : 'A', ba: 'B', ...(i === 5 ? { replies: { ab: { reason: '后一份更全', differences: ['B 列了来源'] }, ba: { unreadable: '???' } } } : {}) }))
  return pilotRawRecords([family], { out: '/o', backend: 'scripted', model: 'm', planSha256: 'h'.repeat(64), judges: { pass: true, samples: 77, failed: [], uncovered: [] }, referencePairs: refs, notes: [] })
}

test('pilot records and report: no ids or absolute paths in the records; the same records give the same bytes; reliability and comparisons as computed', () => {
  const raw = sampleRaw()
  assert.deepEqual(validatePilotRecords(raw), [])
  assert.equal(raw.arms.docs.memory.home, 'homes/docs-memory')
  assert.equal(/jobId|"\/o\//.test(JSON.stringify(raw)), false)
  assert.equal(raw.runs.find(r => r.runId === 'parent#docs/holdout/a#2')?.unclear, 1)
  const report = buildPilotReport(raw)
  assert.equal(buildPilotReport(JSON.parse(JSON.stringify(raw))), report)
  assert.match(report, /结论：可靠/)
  assert.match(report, /6 组，选对 5 组/)
  assert.match(report, /\| memory − base \| docs \| 2 \| \+50\.0 \| \[\+50\.0, \+50\.0\] \| 正 \|/)
  assert.match(report, /\| parent − memory \| docs \| 2 \| -16\.7 \|/)
  assert.match(report, /2 个要点判定，2 个两边都有，一致 1 个（50\.0%）/)
  assert.match(report, /\| docs \| `mmmmmmmmmmmmmmmm…` \| 3 \| 3 \/ 0 \| `dddddddddddddddd…` \| 6（判定完成 6） \| 6 \|/)
  assert.match(report, /\| docs \| base \| 6 \| 6 \| 0（0\.0%） \| 50\.0% \| 0 \| 2 \|/)
  assert.match(report, /\| docs \| parent \| skill:s \| 0 \| 1 \| 1 \/ 1（100\.0%） \|/)
  assert.match(report, /\| docs \| improvement \| 1 \| 0\.000 \| 1 \|/)
  assert.match(report, /两种顺序结论不一致的比较，两次的理由/)
  assert.match(report, /\| 参考 p6 \| AB \| B \| 后一份更全；差别：B 列了来源 \|/)
  assert.match(report, /\| 参考 p6 \| BA \| B \| 回复无法解析：\?\?\? \|/)
  assert.equal(raw.referencePairs[5].replies.ab.reason, '后一份更全', 'replies are kept in the raw records')
  const broken = { ...raw, runs: [...raw.runs, raw.runs[0]] }
  assert.throws(() => buildPilotReport(broken), /appears more than once/)
})

const built = (await loadPackages()).ok
test('memory arm: the policy is written and adopted through the capability store; a second context policy is refused', { skip: built ? false : 'packages not built (pnpm build)' }, async () => {
  const pkgs = /** @type {any} */ (await loadPackages()).pkgs
  const dir = await mkdtemp(join(tmpdir(), 'nx6-mem-'))
  try {
    await mkdir(join(dir, '.nexgent', 'capabilities'), { recursive: true })
    const entries = [{ at: '2026-10-14T00:00:02Z', comment: '第二条' }, { at: '2026-10-14T00:00:01Z', comment: '第一条' }]
    const adopted = await adoptMemoryPolicy(pkgs, dir, entries)
    assert.equal(adopted.kept, 2)
    assert.match(adopted.digest, /^[0-9a-f]{64}$/)
    const store = new pkgs.capabilities.CapabilityStore(join(dir, '.nexgent', 'capabilities'))
    const { activation, bundle } = await store.resolveAdopted()
    assert.equal(activation.version, adopted.version)
    assert.deepEqual(bundle.manifest.components.map((/** @type {any} */ c) => `${c.kind}:${c.name}`), [`context-policy:${MEMORY_POLICY.name}`])
    const policy = JSON.parse(await readFile(join(bundle.directory, 'context', MEMORY_POLICY.name, 'policy.json'), 'utf8'))
    assert.equal(policy.description, MEMORY_POLICY.description)
    assert.equal(policy.instructions, `${MEMORY_POLICY.title}\n\n- 第一条\n- 第二条\n`)
    const decisions = await store.decisions()
    assert.equal(decisions.at(-1).outcome, 'adopted')
    await assert.rejects(adoptMemoryPolicy(pkgs, dir, entries), /already has a context policy/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('holdout outputs: the case\'s output files and folders are copied out before the run copy goes; missing ones are skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-keep-'))
  try {
    await writeFiles(join(dir, 'run'), { 'd-1/output/a.md': '# A', 'f-1/out/x.csv': 'a,b\n', 'f-1/out/sub/y.txt': 'y' })
    const kept = await keepOutputs({ outputs: ['d-1/output/a.md', 'f-1/out', 'd-1/output/missing.md'] }, join(dir, 'run'), join(dir, 'kept'))
    assert.deepEqual(kept, [join(dir, 'kept', 'd-1/output/a.md'), join(dir, 'kept', 'f-1/out')])
    assert.deepEqual(await listFiles(join(dir, 'kept')), ['d-1/output/a.md', 'f-1/out/sub/y.txt', 'f-1/out/x.csv'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
