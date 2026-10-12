/**
 * Step 4 through the SDK (W4): the SDK loads `@nexgent/capabilities`, so the
 * tasks the CLI and the desktop run get the capability tools and run on the
 * version `ctx.capabilityHost` reports: `session.start.capabilityVersion`,
 * ledger stamps, and the session's scope handed to `attach`.
 */
import * as nodePath from 'node:path'
import type { CapabilityAttachInput, CapabilityHost, Context, SessionRecord } from '@nexgent/kernel'
import { readLedgerRecords, readSessionRecords } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { step4ProfileRows } from '../src/index.js'
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
