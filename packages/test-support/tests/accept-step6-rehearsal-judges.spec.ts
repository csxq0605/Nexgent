import { describe, expect, it } from 'vitest'
import { judgeHoldoutArms, judgeIsolation } from '../../../scripts/accept-common/step6-rehearsal-judges.mjs'

type Obs = Record<string, any>

const families = ['tables', 'code']
const holdoutCaseIds = ['tables/holdout/a', 'tables/holdout/b', 'code/holdout/c']
const arms = ['base', 'parent', 'child']

const root = (family: string, label: string) => ({
  family,
  label: `${family} ${label}`,
  root: `/w/${family}/${label}`,
  exists: true,
  scanned: 50,
  skipped: [],
  leaks: [],
  directories: { sessions: { scanned: 5 }, snapshots: { scanned: 20 } },
})

/** Hand-built observations as step6-rehearsal.mjs makes them, a clean run. */
function good(): Obs {
  const runs: Obs[] = []
  const records: Obs[] = []
  for (const caseId of holdoutCaseIds) {
    for (const arm of arms) {
      for (let repeat = 1; repeat <= 3; repeat += 1) {
        const runId = `${arm}#${caseId}#${repeat}`
        const family = caseId.split('/')[0]
        runs.push({ runId, family, caseId, arm, repeat, pass: repeat !== 1, costUsd: 0.1, componentsUsed: [] })
        records.push({ runId, family, caseId, arm, repeat, claims: 1, copyDir: `/w/${family}/runs/${runId}`, copyExists: true, sessionId: `s-${runId}`, sessionFile: `/w/${family}/runs/${runId}/s.jsonl`, sessionFileExists: true, sessionMatchesCase: true, sessionInArmSource: false })
      }
    }
  }
  return {
    scripted: true,
    holdoutCaseIds,
    arms,
    repeatsRequired: 3,
    raw: { runs },
    isolation: {
      roots: families.flatMap(f => ['project', 'arm:base', 'arm:parent', 'arm:child'].map(l => root(f, l))),
      negativeControl: { planted: true, caseId: holdoutCaseIds[0], cleanScanned: 1, cleanLeaks: 0, plantedScanned: 1, plantedLeaks: 1, foundPlantedCase: true },
    },
    gate: {
      families: families.map(family => ({ family, trialFiles: 2, picked: [`${family}/dev/x`, `${family}/guard/y`], unmapped: [] })),
    },
    holdout: {
      families: families.map(family => ({
        family,
        records: records.filter(r => r.family === family),
        directories: records.filter(r => r.family === family).map(r => r.copyDir),
      })),
    },
  }
}

const isolationOf = (mutate: (obs: Obs) => void) => {
  const obs = good()
  mutate(obs)
  return judgeIsolation(obs)
}
const armsOf = (mutate: (obs: Obs) => void) => {
  const obs = good()
  mutate(obs)
  return judgeHoldoutArms(obs)
}
const recordOf = (obs: Obs, runId: string) => obs.holdout.families.flatMap((f: Obs) => f.records).find((r: Obs) => r.runId === runId)

describe('judgeIsolation (E02)', () => {
  it('passes a clean scan with a working negative control and no holdout pick, and says it is a rehearsal', () => {
    const result = judgeIsolation(good())
    expect(result).toMatchObject({ status: 'passed', evidence: expect.stringContaining('scripted rehearsal') })
  })

  it('fails on missing, crashed or empty observations', () => {
    expect(judgeIsolation(undefined)).toMatchObject({ status: 'failed' })
    expect(judgeIsolation({ error: 'boom' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('crashed') })
    expect(judgeIsolation({ holdoutCaseIds })).toMatchObject({ status: 'failed' })
    expect(isolationOf(o => { o.isolation.roots = [] })).toMatchObject({ status: 'failed' })
  })

  it('fails when a leak is found', () => {
    const result = isolationOf(o => { o.isolation.roots[0].leaks = [{ caseId: 'tables/holdout/a', file: 'sessions/x/session.jsonl', fingerprint: 'f' }] })
    expect(result).toMatchObject({ status: 'failed', evidence: expect.stringContaining('leak of tables/holdout/a in sessions/x/session.jsonl') })
  })

  it('fails when the gate picked a holdout case, or picked nothing, or named an unmapped session', () => {
    expect(isolationOf(o => { o.gate.families[0].picked.push('tables/holdout/b') })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('gate picked holdout case tables/holdout/b') })
    expect(isolationOf(o => { o.gate.families[1].picked = [] })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('picked no case') })
    expect(isolationOf(o => { o.gate.families[0].unmapped = ['abcdef0123'] })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('maps to no case') })
    expect(isolationOf(o => { o.gate.families[0].trialFiles = 0 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no trial record') })
  })

  it('fails when the scan covered no sessions or no snapshots, or skipped a root', () => {
    expect(isolationOf(o => { o.isolation.roots[0].directories.sessions.scanned = 0 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no session files') })
    expect(isolationOf(o => { o.isolation.roots[2].directories.snapshots.scanned = 0 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no snapshot files') })
    expect(isolationOf(o => { o.isolation.roots[1].scanned = 0 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no files') })
    expect(isolationOf(o => { o.isolation.roots[3].exists = false })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('does not exist') })
    expect(isolationOf(o => { o.isolation.roots = o.isolation.roots.filter((r: Obs) => r.label !== 'code arm:child') })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('code: arm:child was not scanned') })
  })

  it('fails when the negative control did not detect the plant, or did not run, or the clean copy was dirty', () => {
    expect(isolationOf(o => { o.isolation.negativeControl.plantedLeaks = 0; o.isolation.negativeControl.foundPlantedCase = false })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('did not find the planted') })
    expect(isolationOf(o => { o.isolation.negativeControl.foundPlantedCase = false })).toMatchObject({ status: 'failed' })
    expect(isolationOf(o => { o.isolation.negativeControl = { planted: false, reason: 'no session' } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('did not run') })
    expect(isolationOf(o => { delete o.isolation.negativeControl })).toMatchObject({ status: 'failed' })
    expect(isolationOf(o => { o.isolation.negativeControl.cleanLeaks = 1 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('unplanted copy') })
    expect(isolationOf(o => { o.isolation.negativeControl.plantedScanned = 0 })).toMatchObject({ status: 'failed' })
  })
})

describe('judgeHoldoutArms (E03)', () => {
  it('passes 3 runs for every holdout case × arm in their own copies and sessions, and says it is a rehearsal', () => {
    const result = judgeHoldoutArms(good())
    expect(result).toMatchObject({ status: 'passed', evidence: expect.stringContaining('27 runs') })
    expect(result.evidence).toContain('scripted rehearsal')
  })

  it('fails on missing, crashed or evidence-free observations', () => {
    expect(judgeHoldoutArms(undefined)).toMatchObject({ status: 'failed' })
    expect(judgeHoldoutArms({ error: 'boom' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('crashed') })
    expect(armsOf(o => { o.holdout = { families: [] } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no per-run copy or session') })
    expect(armsOf(o => { o.raw.runs = [] })).toMatchObject({ status: 'failed' })
    expect(armsOf(o => { o.arms = ['base', 'child'] })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('parent') })
  })

  it('fails when a case × arm has only 2 runs', () => {
    const result = armsOf(o => {
      o.raw.runs = o.raw.runs.filter((r: Obs) => !(r.caseId === 'code/holdout/c' && r.arm === 'parent' && r.repeat === 3))
    })
    expect(result).toMatchObject({ status: 'failed', evidence: expect.stringContaining('code/holdout/c parent: 2 runs with distinct repeats, need 3') })
  })

  it('fails when repeat numbers are not distinct (3 records, 2 distinct repeats)', () => {
    const result = armsOf(o => { o.raw.runs.find((r: Obs) => r.runId === 'base#tables/holdout/a#3').repeat = 2 })
    expect(result).toMatchObject({ status: 'failed', evidence: expect.stringContaining('repeat numbers repeat') })
  })

  it('fails when two runs share a session or a copy directory', () => {
    const sharedSession = armsOf(o => { recordOf(o, 'parent#tables/holdout/a#2').sessionId = recordOf(o, 'parent#tables/holdout/a#1').sessionId })
    expect(sharedSession).toMatchObject({ status: 'failed', evidence: expect.stringContaining('session id') })
    expect(sharedSession.evidence).toContain('parent#tables/holdout/a#1')
    const sharedCopy = armsOf(o => { recordOf(o, 'child#code/holdout/c#3').copyDir = recordOf(o, 'child#code/holdout/c#2').copyDir })
    expect(sharedCopy).toMatchObject({ status: 'failed', evidence: expect.stringContaining('copy directory') })
  })

  it('fails when a run has no copy, no session, no session file, or a session that is not its case', () => {
    expect(armsOf(o => { recordOf(o, 'base#tables/holdout/a#1').copyExists = false })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('copy directory is missing') })
    expect(armsOf(o => { delete recordOf(o, 'base#tables/holdout/a#1').sessionId })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no session id') })
    expect(armsOf(o => { recordOf(o, 'base#tables/holdout/a#1').sessionFileExists = false })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('session file is not in the copy') })
    expect(armsOf(o => { recordOf(o, 'base#tables/holdout/a#1').sessionMatchesCase = false })).toMatchObject({ status: 'failed', evidence: expect.stringContaining("case's message") })
    expect(armsOf(o => { recordOf(o, 'base#tables/holdout/a#1').sessionInArmSource = true })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('reused') })
    expect(armsOf(o => { o.holdout.families[0].records.pop() })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no run directory or session') })
    expect(armsOf(o => { recordOf(o, 'base#tables/holdout/a#1').claims = 2 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('2 sessions claim') })
  })

  it('counts unknown results apart and never as passes; anything else that is not a boolean fails', () => {
    const result = armsOf(o => { o.raw.runs.find((r: Obs) => r.runId === 'base#tables/holdout/a#1').pass = null })
    expect(result).toMatchObject({ status: 'passed', evidence: expect.stringContaining('1 unknown') })
    expect(result.evidence).toContain('18 passed, 8 failed, 1 unknown')
    expect(armsOf(o => { o.raw.runs[0].pass = 'unknown' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('not true, false or null') })
    expect(armsOf(o => { delete o.raw.runs[0].pass })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('not true, false or null') })
  })

  it('fails when the runner stopped early or the run directories do not match the runs', () => {
    expect(armsOf(o => { o.holdout.families[1].stopped = { step: 'meta', reason: 'budget' } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('stopped early') })
    expect(armsOf(o => { o.holdout.families[0].directories.push('/w/extra') })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('run directories') })
  })
})
