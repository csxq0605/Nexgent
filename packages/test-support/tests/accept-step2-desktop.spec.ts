/**
 * The accept-step2 D judges against one real desktop run (built Electron app,
 * real renderer and SDK, scripted model; Linux without DISPLAY starts Xvfb)
 * and, for every judge, a copy of that run broken in the one way the judge
 * exists to catch.
 *
 * Needs the packages built (`pnpm build`), like the acceptance script.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESKTOP_JUDGES, judgeDesktop } from '../../../scripts/accept-common/step2-desktop-judges.mjs'
import { desktopPrerequisites, runDesktopScenario } from '../../../scripts/accept-common/step2-desktop.mjs'
import type { Observations } from '../../../scripts/accept-common/step2-judges.mjs'
import * as h from '../src/index.js'

let work: string
let good: Observations

beforeAll(async () => {
  const ready = await desktopPrerequisites()
  if (!ready.ok) throw new Error(ready.reason)
  work = await mkdtemp(join(tmpdir(), 'nxdesktop-'))
  good = await runDesktopScenario(h, work)
}, 240_000)

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true, maxRetries: 5 })
})

function broken(mutate: (obs: Observations) => void): Observations {
  const copy = structuredClone(good)
  mutate(copy)
  return copy
}

describe('accept-step2 D judges', () => {
  it('all pass on a real run', () => {
    expect(good.error, JSON.stringify(good.error)).toBeUndefined()
    for (const id of Object.keys(DESKTOP_JUDGES)) {
      const result = judgeDesktop(id, good)
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
  })

  const cases: Array<[string, string, (obs: Observations) => void]> = [
    ['D01', 'a renderer console error in the second launch', obs => { obs.consoleErrors.second.push('Uncaught TypeError') }],
    ['D01', 'sandbox off', obs => { obs.window.prefs.sandbox = false }],
    ['D01', 'the page sees Node', obs => { obs.window.pageGlobals = ['function', 'object'] }],
    ['D01', 'the bridge exposes the token', obs => { obs.window.bridgeKeys = ['invoke', 'onEvent', 'platform', 'token'] }],
    ['D02', 'the project does not reopen after restart', obs => { delete obs.restart }],
    ['D02', 'the project is missing from the recent list', obs => { obs.restart.recent = [] }],
    ['D03', 'only one material shows', obs => { obs.materials.count = 1 }],
    ['D03', 'the file dialog was never opened', obs => { obs.materials.dialogCalls = [] }],
    ['D04', 'the text only appeared when complete', obs => { obs.stream.partialText = '我先写一份按地区的汇总。' }],
    ['D04', 'no tool blocks', obs => { obs.stream.toolBlocksDuringTurn = 0 }],
    ['D05', 'no approval dialog', obs => { delete obs.approval.dialogShown }],
    ['D05', 'the turn did not continue', obs => { obs.approval.toolBlocks = 1; obs.approval.turnEnds = ['error'] }],
    ['D06', 'no v2', obs => { obs.deliverable.cardsAfterFeedback = 1; obs.deliverable.versions = [1] }],
    ['D06', 'the diff shows the wrong change', obs => { obs.deliverable.added = [] }],
    ['D06', 'feedback not recorded', obs => { obs.deliverable.feedback = [] }],
    ['D07', 'the streamed text vanished from the UI', obs => { obs.stop.kept = '' }],
    ['D07', 'the session lost the interrupted text', obs => { obs.stop.interrupted = [] }],
    ['D07', 'the turn completed instead of being cancelled', obs => { obs.stop.turnEnds = ['completed', 'completed', 'completed'] }],
    ['D08', 'deliverables gone after restart', obs => { obs.restart.cards = 0 }],
    ['D08', 'continuing fails', obs => { obs.restart.continued = ''; obs.restart.turnEnds = ['completed', 'completed', 'cancelled', 'interrupted', 'error'] }],
    ['D08', 'killed after the turn had ended', obs => { obs.kill.runningBeforeKill = false }],
    ['D09', 'config.json not updated', obs => { obs.settings.config.thinking = 'on' }],
    ['D09', 'the key value is on the page', obs => { obs.settings.pageHasKey = true }],
    ['D10', 'a wrong token is accepted', obs => { obs.ipc.wrong = { ok: true, value: [] } }],
    ['D10', 'the token is in the log', obs => { obs.ipc.logHasToken = true }],
    ['D10', 'an unlisted method goes through', obs => { obs.ipc.unlisted = 'resolved' }],
  ]

  for (const [id, defect, mutate] of cases) {
    it(`${id} fails when ${defect}`, () => {
      const result = judgeDesktop(id, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(Object.keys(DESKTOP_JUDGES).filter(id => !covered.has(id))).toEqual([])
  })

  it('a stopped scenario fails the later items and says where it stopped', () => {
    const obs = broken((o) => {
      delete o.restart
      o.error = { step: 'D08 restart', message: 'timed out waiting for the workspace' }
    })
    const result = judgeDesktop('D08', obs)
    expect(result.status).toBe('failed')
    expect(result.evidence).toContain('scenario stopped at D08 restart')
    expect(judgeDesktop('D03', obs).status).toBe('passed')
  })

  it('no observations at all is a failure, never a pass', () => {
    for (const id of Object.keys(DESKTOP_JUDGES)) expect(judgeDesktop(id, {}).status, id).toBe('failed')
  })
})
