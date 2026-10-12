/**
 * Step 4 through the SDK (W4): the SDK loads `@nexgent/capabilities`, so the
 * tasks the CLI and the desktop run get the capability tools and run on the
 * version `ctx.capabilityHost` reports: `session.start.capabilityVersion`,
 * ledger stamps, and the session's scope handed to `attach`.
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { CapabilityService, listCandidates } from '@nexgent/capabilities'
import type { CapabilityAttachInput, CapabilityHost, Context, SessionRecord } from '@nexgent/kernel'
import { readLedgerRecords, readSessionRecords } from '@nexgent/test-support'
import { describe, expect, it, onTestFinished } from 'vitest'
import { step4ProfileRows, type CapabilityGateEntry, type SdkEvent } from '../src/index.js'
import { capabilitiesDir, capabilityStore, gateDecision, plugin, propose, skill, trialReceipts, verdict } from './capability-fixtures.js'
import { testSdk } from './helpers.js'

const VERSION = 'c'.repeat(64)

describe('capability versions through the SDK', () => {
  it('loads @nexgent/capabilities as the step-4 row: root sessions see the capability tools', async () => {
    expect(step4ProfileRows()).toEqual([{ id: 'capabilities', name: '@nexgent/capabilities' }])
    const t = await testSdk([{ content: 'ok' }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: session.sessionId, text: 'hi' })
    expect((await started.done).reason).toEqual({ kind: 'completed' })
    const tools = t.providers[0]!.llm.calls[0]!.request.tools?.map(tool => tool.name) ?? []
    expect(tools).toEqual(expect.arrayContaining(['capability_draft', 'capability_try', 'capability_propose']))
    // The plugin is the capability host: a project with nothing adopted runs on baseline.
    const records = (await readSessionRecords(project.root, session.sessionId)).records as SessionRecord[]
    expect(records.find(record => record.type === 'session.start')).toMatchObject({ capabilityVersion: 'baseline' })
    const outcome = (await readLedgerRecords(project.root)).records.find(record => record.type === 'task.outcome')
    expect(outcome).toMatchObject({ capabilityVersion: 'baseline' })
  })

  it('runs a task on the version ctx.capabilityHost reports (session start, ledger, attach)', async () => {
    const attached: CapabilityAttachInput[] = []
    const host: CapabilityHost = {
      current: async () => VERSION,
      verify: async () => ({ ok: true }),
      attach: async input => {
        attached.push(input)
        return { components: [] }
      },
    }
    // The `@nexgent/capabilities` row resolved to a host stand-in: the row is wired, whatever the plugin provides.
    const t = await testSdk([{ content: 'ok' }], {
      registry: {
        '@nexgent/capabilities': { name: 'capability-host', apply: (ctx: Context) => void ctx.provide('capabilityHost', host) },
      },
    })
    const root = nodePath.join(t.base, 'p')
    const project = await t.sdk.call('projects.open', { root, create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: session.sessionId, text: 'hi' })
    expect((await started.done).reason).toEqual({ kind: 'completed' })

    const records = (await readSessionRecords(root, session.sessionId)).records as SessionRecord[]
    expect(records.find(record => record.type === 'session.start')).toMatchObject({ capabilityVersion: VERSION })
    expect(attached).toEqual([expect.objectContaining({ sessionId: session.sessionId, version: VERSION, resumed: false })])
    const ledger = (await readLedgerRecords(root)).records
    expect(ledger.length).toBeGreaterThan(0)
    expect(ledger.every(record => (record as { capabilityVersion?: string }).capabilityVersion === VERSION)).toBe(true)
    expect(ledger.some(record => record.type === 'task.outcome')).toBe(true)
  })
})

type Ev<T extends SdkEvent['type']> = Extract<SdkEvent, { type: T }>
const capabilityEvents = (t: { events: SdkEvent[] }) => t.events.filter((event): event is Ev<'capability.version'> | Ev<'capability.candidate'> => event.type === 'capability.version' || event.type === 'capability.candidate')

async function openProject() {
  const t = await testSdk([{ content: 'ok' }])
  const root = nodePath.join(t.base, 'p')
  const project = await t.sdk.call('projects.open', { root, create: true })
  return { t, root, projectId: project.projectId }
}

describe('capabilities.* (step 4, W4)', () => {
  it('reports the baseline of a fresh project: no history, no candidates', async () => {
    const { t, projectId } = await openProject()
    expect(await t.sdk.call('capabilities.current', { projectId })).toEqual({ version: 'baseline', revision: 0, components: [] })
    expect(await t.sdk.call('capabilities.list', { projectId })).toEqual({ current: { version: 'baseline', revision: 0, components: [] }, history: [], candidates: [] })
    await expect(t.sdk.call('capabilities.rollback', { projectId })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(t.sdk.call('capabilities.show', { projectId, candidateId: randomUUID() })).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('derives candidate status from the files: proposed, trialing, rejected with its reason, adopted, rolled back', async () => {
    const { t, root, projectId } = await openProject()
    const proposed = await propose(root, [skill('north-summary')])
    const trialing = await propose(root, [skill('south-summary')])
    await trialReceipts(root, trialing)
    const rejected = await propose(root, [skill('east-summary')])
    const rejectedTrial = await trialReceipts(root, rejected, verdict('reject', 'quality-down'))
    await gateDecision(root, rejected, rejectedTrial, verdict('reject', 'quality-down'), 'The candidate passed fewer selection checks than the baseline.')
    const good = await propose(root, [skill('west-summary')])
    const goodTrial = await trialReceipts(root, good, verdict('adopt', 'quality-up'))
    await capabilityStore(root).adopt(good.version, { trigger: 'gate', reason: 'quality-up', candidateId: good.id, trialId: goodTrial, verdict: verdict('adopt', 'quality-up'), detail: 'adopted by the gate' })

    const listing = await t.sdk.call('capabilities.list', { projectId })
    expect(listing.current).toMatchObject({ version: good.version, revision: 1, trigger: 'gate', components: [{ kind: 'skill', name: 'west-summary' }] })
    expect(listing.history).toEqual([expect.objectContaining({ revision: 1, type: 'adopt', version: good.version, trigger: 'gate' })])
    const status = Object.fromEntries(listing.candidates.map(candidate => [candidate.id, candidate.status]))
    expect(status).toEqual({ [proposed.id]: 'proposed', [trialing.id]: 'trialing', [rejected.id]: 'rejected', [good.id]: 'adopted' })
    expect(listing.candidates.map(candidate => candidate.id)).toEqual([good.id, rejected.id, trialing.id, proposed.id])
    const rejectedView = listing.candidates.find(candidate => candidate.id === rejected.id)!
    expect(rejectedView).toMatchObject({ trialId: rejectedTrial, decision: { outcome: 'rejected', reason: 'quality-down', detail: 'The candidate passed fewer selection checks than the baseline.' }, summary: 'reusable order summary' })

    const detail = await t.sdk.call('capabilities.show', { projectId, candidateId: rejected.id })
    expect(detail.record).toEqual(rejected)
    expect(detail.receipts.map(receipt => receipt.type)).toEqual(['trial.start', 'trial.end'])
    expect(detail.decisions).toEqual([expect.objectContaining({ outcome: 'rejected', reason: 'quality-down' })])

    // Manual rollback: back to baseline; the adopted candidate reads rolled-back; one version event.
    const back = await t.sdk.call('capabilities.rollback', { projectId, reason: 'summaries look wrong' })
    expect(back).toMatchObject({ version: 'baseline', revision: 2, trigger: 'manual' })
    const after = await t.sdk.call('capabilities.list', { projectId })
    expect(after.history.at(-1)).toMatchObject({ type: 'rollback', trigger: 'manual', from: good.version, version: 'baseline' })
    expect(after.candidates.find(candidate => candidate.id === good.id)?.status).toBe('rolled-back')
    const decisions = await capabilityStore(root).decisions()
    expect(decisions.at(-1)).toMatchObject({ outcome: 'rolled-back', reason: 'manual', trigger: 'manual', detail: 'Rolled back by the user: summaries look wrong' })
    expect(capabilityEvents(t).map(event => event.type)).toEqual(['capability.version'])
    const event = capabilityEvents(t)[0] as Ev<'capability.version'>
    expect(event).toMatchObject({ projectId, eventSeq: 1, current: { version: 'baseline', revision: 2 } })
    expect(event.sessionId).toBeUndefined()
  })

  it('rolls back down the stack to an earlier version', async () => {
    const { t, root, projectId } = await openProject()
    const store = capabilityStore(root)
    const one = await store.write([skill('one')])
    const two = await store.write([skill('one'), skill('two')])
    await store.adopt(one.version, { trigger: 'manual' })
    await store.adopt(two.version, { trigger: 'manual' })
    await expect(t.sdk.call('capabilities.rollback', { projectId, toVersion: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect(await t.sdk.call('capabilities.rollback', { projectId, toVersion: 'baseline' })).toMatchObject({ version: 'baseline', revision: 4 })
    expect((await store.history()).map(revision => [revision.type, revision.version])).toEqual([['adopt', one.version], ['adopt', two.version], ['rollback', one.version], ['rollback', 'baseline']])
  })

  it('answers a plugin candidate awaiting approval: deny keeps the version, allow adopts it', async () => {
    const { t, root, projectId } = await openProject()
    const denied = await propose(root, [plugin('greeter')])
    expect(denied.requiresApproval).toBe(true)
    const deniedTrial = await trialReceipts(root, denied, verdict('await-approval', 'quality-up'))
    await gateDecision(root, denied, deniedTrial, verdict('await-approval', 'quality-up'), 'Passed its gate; a plugin needs approval.')
    expect((await t.sdk.call('capabilities.show', { projectId, candidateId: denied.id })).view.status).toBe('awaiting-approval')
    await expect(t.sdk.call('capabilities.approve', { projectId, candidateId: denied.id, decision: 'maybe' as never })).rejects.toMatchObject({ code: 'tool/invalid-input' })

    const deny = await t.sdk.call('capabilities.approve', { projectId, candidateId: denied.id, decision: 'deny' })
    expect(deny).toMatchObject({ status: 'rejected', decision: { outcome: 'rejected', reason: 'approval-denied' } })
    expect((await t.sdk.call('capabilities.current', { projectId })).version).toBe('baseline')
    await expect(t.sdk.call('capabilities.approve', { projectId, candidateId: denied.id, decision: 'allow' })).rejects.toMatchObject({ code: 'tool/invalid-input' })

    const allowed = await propose(root, [plugin('greeter')], 'greeter again')
    const allowedTrial = await trialReceipts(root, allowed, verdict('await-approval', 'quality-up'))
    await gateDecision(root, allowed, allowedTrial, verdict('await-approval', 'quality-up'), 'Passed its gate; a plugin needs approval.')
    const allow = await t.sdk.call('capabilities.approve', { projectId, candidateId: allowed.id, decision: 'allow' })
    expect(allow).toMatchObject({ status: 'adopted', decision: { outcome: 'adopted', reason: 'approved' } })
    expect(await t.sdk.call('capabilities.current', { projectId })).toMatchObject({ version: allowed.version, trigger: 'approval', components: [{ kind: 'plugin', name: 'greeter' }] })
    const decision = (await capabilityStore(root).decisions()).at(-1)!
    expect(decision).toMatchObject({ outcome: 'adopted', trigger: 'approval', candidateId: allowed.id, trialId: allowedTrial })
    expect(capabilityEvents(t).map(event => event.type === 'capability.candidate' ? `${event.type}:${event.candidate.status}` : event.type))
      .toEqual(['capability.candidate:rejected', 'capability.candidate:adopted', 'capability.version'])
  })

  it('says when no gate is available for capabilities.trial', async () => {
    const { t, root, projectId } = await openProject()
    const candidate = await propose(root, [skill('north-summary')])
    await expect(t.sdk.call('capabilities.trial', { projectId, candidateId: candidate.id })).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('not implemented yet') })
  })

  it('hands a proposed candidate to the gate entry of the capability service', async () => {
    const started: string[] = []
    let root = ''
    // A gate entry on the capability service, the way the gate engine will add it.
    const proto = CapabilityService.prototype as unknown as Partial<CapabilityGateEntry>
    proto.startTrial = async (id: string) => {
      started.push(id)
      const record = (await listCandidates(capabilitiesDir(root))).find(candidate => candidate.id === id)!
      await trialReceipts(root, record)
    }
    onTestFinished(() => void delete proto.startTrial)
    const t = await testSdk([{ content: 'ok' }])
    root = nodePath.join(t.base, 'p')
    const { projectId } = await t.sdk.call('projects.open', { root, create: true })
    const candidate = await propose(root, [skill('north-summary')])
    const view = await t.sdk.call('capabilities.trial', { projectId, candidateId: candidate.id })
    expect(started).toEqual([candidate.id])
    expect(view.status).toBe('trialing')
    expect(capabilityEvents(t)).toEqual([expect.objectContaining({ type: 'capability.candidate', candidate: expect.objectContaining({ id: candidate.id, status: 'trialing' }) })])
    await expect(t.sdk.call('capabilities.trial', { projectId, candidateId: candidate.id })).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('falls back from a tampered adopted bundle the way a new session would, and says so', async () => {
    const { t, root, projectId } = await openProject()
    const store = capabilityStore(root)
    const bundle = await store.write([skill('north-summary')])
    await store.adopt(bundle.version, { trigger: 'manual' })
    await writeFile(nodePath.join(capabilitiesDir(root), bundle.version, 'skills', 'north-summary', 'SKILL.md'), 'tampered\n')
    const current = await t.sdk.call('capabilities.current', { projectId })
    expect(current).toMatchObject({ version: 'baseline', revision: 2, trigger: 'load-failure' })
    expect((await store.history()).at(-1)).toMatchObject({ type: 'rollback', trigger: 'load-failure' })
    expect(capabilityEvents(t)).toEqual([expect.objectContaining({ type: 'capability.version', current: expect.objectContaining({ trigger: 'load-failure' }) })])
  })
})
