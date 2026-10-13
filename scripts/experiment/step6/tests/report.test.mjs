import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, validateRecords } from '../report.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function raw() {
  const runs = []
  const plan = {
    tables: { 'tables/holdout/region-2026-12': { base: [false, false, false], parent: [true, true, false], child: [true, true, true] }, 'tables/holdout/returns-2027-02': { base: [false, false, true], parent: [true, false, false], child: [true, true, null] } },
    code: { 'code/holdout/refactor-108': { base: [true, false, false], parent: [true, false, true], child: [true, true, false] } },
  }
  for (const [family, cases] of Object.entries(plan)) {
    for (const [caseId, arms] of Object.entries(cases)) {
      for (const [arm, results] of Object.entries(arms)) {
        results.forEach((pass, repeat) => runs.push({ runId: `${arm}-${caseId.split('/').pop()}-${repeat}`, family, caseId, arm, repeat, pass, costUsd: arm === 'base' ? 0.1 : 0.08, componentsUsed: arm === 'base' ? [] : ['skill:avg-order-value'] }))
      }
    }
  }
  return {
    manifest: { experimentId: 'scripted-1', epochId: 'ep-1', model: 'scripted', thinking: true, improvers: { parent: 'imp-v0', child: 'imp-v1' }, decisions: { tables: 'adopt-child' } },
    runs: runs.reverse(),
    costs: [
      { kind: 'improvement', family: 'tables', usd: 1.05, ref: 'job-1' },
      { kind: 'meta', family: 'tables', usd: 0.3, ref: 'meta-1' },
      { kind: 'comparison', family: 'tables', usd: 2.1, ref: 'cmp-1' },
      { kind: 'history', family: 'code', usd: 0.45, ref: 'hist' },
    ],
    disagreements: [{ family: 'tables', ref: 'job-1/fc-2', note: 'feedback check passed, hidden judge failed' }],
  }
}

test('the same records give byte-identical reports', () => {
  const a = buildReport(raw(), { iterations: 2000 })
  const b = buildReport(JSON.parse(JSON.stringify(raw())), { iterations: 2000 })
  assert.equal(a, b)
})

test('run order in the records does not change the report', () => {
  const shuffled = raw()
  shuffled.runs = [...shuffled.runs].sort((x, y) => x.runId.localeCompare(y.runId))
  assert.equal(buildReport(raw(), { iterations: 1000 }), buildReport(shuffled, { iterations: 1000 }))
})

test('the report carries verdicts, per-case results with run ids, costs, amortization and gaps', () => {
  const text = buildReport(raw(), { iterations: 2000 })
  assert.match(text, /## 结论/)
  assert.match(text, /\| tables \| parent − base \| 2 \| \+33\.3 \|/)
  assert.match(text, /\| tables\/holdout\/region-2026-12 \| 0\/3 \| 2\/3 \| 3\/3 \|/)
  assert.match(text, /2\/2（未知 1）/)
  assert.match(text, /child-returns-2027-02-2/)
  assert.match(text, /\| tables \| child \| 3\.450 \| 0\.020 \| 173 \| 0\.041 \|/)
  assert.match(text, /\| code \| child \| 没有投入记录 \|/)
  assert.match(text, /结果未知（不算通过）：1 次：child-returns-2027-02-2/)
  assert.match(text, /已知结果少于 3 次的用例与臂：tables\/holdout\/returns-2027-02（child，已知 2 次）/)
  assert.match(text, /共 1 次/)
  assert.match(text, /零（样本内看不出差别）|正|负/)
})

test('records that cannot be used are refused with the reasons', () => {
  const bad = raw()
  bad.runs[0].arm = 'grandchild'
  bad.runs[1].pass = 'yes'
  bad.runs.push({ ...bad.runs[2] })
  const problems = validateRecords(bad)
  assert.equal(problems.length, 3, problems.join('\n'))
  assert.throws(() => buildReport(bad), /not usable/)
  assert.deepEqual(validateRecords({}), ['manifest.experimentId is missing', 'runs is not an array', 'costs is not an array'])
})

test('no pairable case is reported as missing data, not as zero', () => {
  const text = buildReport({ manifest: { experimentId: 'empty' }, runs: [], costs: [] }, { iterations: 10 })
  assert.match(text, /缺测，没有可配对的用例/)
})

test('the command line writes the same report twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-r-'))
  try {
    await writeFile(join(dir, 'raw.json'), JSON.stringify(raw()))
    const script = join(here, '..', 'report.mjs')
    for (const out of ['a.md', 'b.md']) {
      const result = spawnSync(process.execPath, [script, '--records', join(dir, 'raw.json'), '--out', join(dir, out), '--iterations', '1000'])
      assert.equal(result.status, 0, String(result.stderr))
    }
    assert.equal(await readFile(join(dir, 'a.md'), 'utf8'), await readFile(join(dir, 'b.md'), 'utf8'))
    assert.equal(spawnSync(process.execPath, [script]).status, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
