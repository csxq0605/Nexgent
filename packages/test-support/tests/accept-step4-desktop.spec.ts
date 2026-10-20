/**
 * The accept-step4 D15–D18 judges against one real capabilities run (built
 * Electron app, real renderer and SDK, scripted model; the capability files
 * written as the store and the gate write them; Linux without DISPLAY starts
 * Xvfb) and, for every judge, a copy of that run broken in the one way the
 * judge exists to catch.
 *
 * Needs the packages built (`pnpm build`), like the acceptance script.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desktopPrerequisites } from '../../../scripts/accept-common/step2-desktop.mjs'
import { runCapabilitiesDesktopScenario, type CapabilitiesObservations } from '../../../scripts/accept-common/step4-desktop.mjs'
import { CAPABILITY_JUDGES, judgeCapabilities } from '../../../scripts/accept-common/step4-desktop-judges.mjs'
import * as h from '../src/index.js'

let work: string
let good: CapabilitiesObservations

beforeAll(async () => {
  const ready = await desktopPrerequisites()
  if (!ready.ok) throw new Error(ready.reason)
  work = await mkdtemp(join(tmpdir(), 'nxcaps-'))
  good = await runCapabilitiesDesktopScenario(h, work)
}, 240_000)

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true, maxRetries: 5 })
})

function broken(mutate: (obs: CapabilitiesObservations) => void): CapabilitiesObservations {
  const copy = structuredClone(good)
  mutate(copy)
  return copy
}
const candidate = (panel: Record<string, any>, id: string) => panel['candidates'].find((c: Record<string, unknown>) => c['id'] === id)

describe('accept-step4 D15–D18 judges', () => {
  it('all pass on a real run', () => {
    expect(good.error, JSON.stringify(good.error)).toBeUndefined()
    for (const id of Object.keys(CAPABILITY_JUDGES)) {
      const result = judgeCapabilities(id, good)
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
  })

  const cases: Array<[string, string, (obs: CapabilitiesObservations) => void]> = [
    // Updated 2026-10-19: the 能力 page lost the version panel, candidate list, revision list and rollback button;
    // the defects are now about the capability data and about a removed entry coming back.
    ['D15', 'the project did not start on the baseline', obs => { obs.before.version = obs.seed.A.version }],
    ['D15', 'the current version stayed old after the adoption', obs => { obs.after.version = 'baseline' }],
    ['D15', 'the new conversation ran on the old version', obs => { for (const id of Object.keys(obs.secondSessions)) obs.secondSessions[id] = 'baseline' }],
    ['D15', 'the earlier conversation switched version', obs => { for (const id of Object.keys(obs.secondSessions)) obs.secondSessions[id] = obs.seed.A.version }],
    ['D15', 'the components are missing', obs => { obs.after.components = [] }],
    ['D15', 'the old version panel is still on the 能力 page', obs => { obs.after.oldEntries['capability-current'] = 1 }],
    ['D16', 'the trialing candidate reads proposed', obs => { candidate(obs.after, obs.seed.T.id).status = 'proposed' }],
    ['D16', 'the rolled-back candidate still reads adopted', obs => { candidate(obs.after, obs.seed.B.id).status = 'adopted' }],
    ['D16', 'the rejection reason was lost', obs => { candidate(obs.after, obs.seed.R.id).detail = null }],
    ['D16', 'the old candidate list is still on the 能力 page', obs => { obs.after.oldEntries['candidate-status'] = 4 }],
    ['D16', 'the old entries were never counted', obs => { delete obs.after.oldEntries }],
    ['D17', 'an approval dialog appeared', obs => { obs.dialogs.afterNewSession = 1 }],
    ['D17', 'the old awaiting-approval plugin candidate was changed', obs => { candidate(obs.after, obs.seed.P.id).status = 'rejected' }],
    ['D17', 'a decision was added for the plugin', obs => { obs.afterOpen.decisions.push({ outcome: 'rejected', reason: 'approval-denied' }) }],
    ['D17', 'the adopted version changed', obs => { obs.afterOpen.history.push({ type: 'adopt' }) }],
    ['D17', 'the plugin ran', obs => { obs.pluginRan = true }],
    ['D17', 'the dialog came back after the restart', obs => { obs.restart.dialogs = 1 }],
    ['D18', 'the current version disagrees with the history', obs => { obs.rolledBack.revision = 3 }],
    ['D18', 'the rollback call returned another version', obs => { obs.rollbackResult.version = obs.seed.A.version }],
    ['D18', 'the revisions miss the rollback', obs => { obs.rolledBack.revisions = obs.rolledBack.revisions.slice(0, -1) }],
    ['D18', 'the restart shows another version', obs => { obs.restart.version = obs.seed.A.version }],
    ['D18', 'the rollback was not manual', obs => { obs.rolledBack.history.at(-1).trigger = 'usage-regression' }],
    ['D18', 'the rollback button is back after the restart', obs => { obs.restart.oldEntries['capability-rollback'] = 1 }],
    ['D18', 'a renderer console error', obs => { obs.consoleErrors.second.push('Uncaught TypeError') }],
  ]

  for (const [id, defect, mutate] of cases) {
    it(`${id} fails when ${defect}`, () => {
      const result = judgeCapabilities(id, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(Object.keys(CAPABILITY_JUDGES).filter(id => !covered.has(id))).toEqual([])
  })

  it('a stopped scenario fails the later items and says where it stopped', () => {
    const obs = broken((o) => {
      delete o.restart
      o.error = { step: 'D18 restart', message: 'timed out waiting for the workspace' }
    })
    const result = judgeCapabilities('D18', obs)
    expect(result.status).toBe('failed')
    expect(result.evidence).toContain('capabilities scenario stopped at D18 restart')
    expect(judgeCapabilities('D16', obs).status).toBe('passed')
  })

  it('no observations at all is a failure, never a pass', () => {
    for (const id of Object.keys(CAPABILITY_JUDGES)) expect(judgeCapabilities(id, {}).status, id).toBe('failed')
  })
})
