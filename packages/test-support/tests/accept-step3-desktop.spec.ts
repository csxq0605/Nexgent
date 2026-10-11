/**
 * The accept-step3 D11–D14 judges against one real members run (built
 * Electron app, real renderer and SDK, scripted model routed per member;
 * Linux without DISPLAY starts Xvfb) and, for every judge, a copy of that run
 * broken in the one way the judge exists to catch.
 *
 * Needs the packages built (`pnpm build`), like the acceptance script.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desktopPrerequisites } from '../../../scripts/accept-common/step2-desktop.mjs'
import { runMembersDesktopScenario, type MembersObservations } from '../../../scripts/accept-common/step3-desktop.mjs'
import { judgeMembers, MEMBER_JUDGES } from '../../../scripts/accept-common/step3-desktop-judges.mjs'
import * as h from '../src/index.js'

let work: string
let good: MembersObservations

beforeAll(async () => {
  const ready = await desktopPrerequisites()
  if (!ready.ok) throw new Error(ready.reason)
  work = await mkdtemp(join(tmpdir(), 'nxmembers-'))
  good = await runMembersDesktopScenario(h, work)
}, 240_000)

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true, maxRetries: 5 })
})

function broken(mutate: (obs: MembersObservations) => void): MembersObservations {
  const copy = structuredClone(good)
  mutate(copy)
  return copy
}
const block = (blocks: Array<Record<string, unknown>>, name: string) => blocks.find(b => b['member'] === name)!

describe('accept-step3 D11–D14 judges', () => {
  it('all pass on a real run', () => {
    expect(good.error, JSON.stringify(good.error)).toBeUndefined()
    for (const id of Object.keys(MEMBER_JUDGES)) {
      const result = judgeMembers(id, good)
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
  })

  const cases: Array<[string, string, (obs: MembersObservations) => void]> = [
    ['D11', 'no block while the member runs', obs => { obs.running.blocks = [] }],
    ['D11', 'the finished block still reads running', obs => { block(obs.finished.blocks, 'writer')['status'] = 'running' }],
    ['D11', 'no deliverable link', obs => { obs.finished.deliverableLinks = [] }],
    ["D11", "the member's tool calls show in the main conversation", obs => { obs.finished.toolBlocks = 4 }],
    ['D11', 'a renderer console error', obs => { obs.consoleErrors.first.push('Uncaught TypeError') }],
    ['D12', "the view shows another member's session", obs => { obs.view.title = '成员 slow 的会话' }],
    ['D12', 'the view has a composer (not read-only)', obs => { obs.view.composerWhileOpen = 1 }],
    ['D12', 'back does not return', obs => { obs.view.back = false }],
    ['D13', 'the dialog does not name the member', obs => { obs.approval.memberLine = null }],
    ['D13', 'the write did not land after allow', obs => { obs.approval.envAfter = null }],
    ['D13', 'the conversation did not continue', obs => { obs.approval.rootReply = '' }],
    ['D14', 'a member block is gone after restart', obs => { obs.restart.blocks = obs.restart.blocks.slice(0, 1) }],
    ['D14', 'the killed member reads completed', obs => { block(obs.restart.blocks, 'slow')['status'] = 'completed' }],
    ["D14", "the member's deliverable link is gone", obs => { obs.restart.deliverableLinks = [] }],
    ["D14", "the killed member's session does not open", obs => { delete obs.restart.slowView }],
    ['D14', 'killed after the member had finished', obs => { block(obs.kill.blocksBeforeKill, 'slow')['status'] = 'completed' }],
  ]

  for (const [id, defect, mutate] of cases) {
    it(`${id} fails when ${defect}`, () => {
      const result = judgeMembers(id, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(Object.keys(MEMBER_JUDGES).filter(id => !covered.has(id))).toEqual([])
  })

  it('a stopped scenario fails the later items and says where it stopped', () => {
    const obs = broken((o) => {
      delete o.restart
      o.error = { step: 'D14 restart', message: 'timed out waiting for the workspace' }
    })
    const result = judgeMembers('D14', obs)
    expect(result.status).toBe('failed')
    expect(result.evidence).toContain('members scenario stopped at D14 restart')
    expect(judgeMembers('D12', obs).status).toBe('passed')
  })

  it('no observations at all is a failure, never a pass', () => {
    for (const id of Object.keys(MEMBER_JUDGES)) expect(judgeMembers(id, {}).status, id).toBe('failed')
  })
})
