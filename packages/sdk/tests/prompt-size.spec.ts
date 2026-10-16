/**
 * K2 measurement: the fixed part of the first request (system prompt and
 * tool definitions) of a root task through the full SDK. Skipped unless
 * `NEXGENT_PROMPT_DUMP=<file>`; writes `{ system, tools }` there so the
 * tokens can be counted with the Messages API `count_tokens` endpoint.
 */
import { writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testSdk } from './helpers.js'

const DUMP = process.env.NEXGENT_PROMPT_DUMP

describe.skipIf(DUMP === undefined)('first request size', () => {
  it('dumps the system prompt and tool definitions of a root task', async () => {
    const t = await testSdk([{ content: 'done' }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId, title: 'size' })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'Say done.' })
    await vi.waitFor(() => expect(t.providers[0]?.llm.requests.length ?? 0).toBeGreaterThan(0))
    const request = t.providers[0]!.llm.requests[0]!
    const system = request.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n\n')
    const tools = (request.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
    await writeFile(DUMP!, JSON.stringify({ system, tools, messages: request.messages.filter(message => message.role !== 'system') }, null, 2))
    console.log(`PROMPT system=${system.length} chars, ${tools.length} tools, tools json=${JSON.stringify(tools).length} chars: ${tools.map(tool => tool.name).join(', ')}`)
    await vi.waitFor(() => expect(t.sdk.isRunning(project.projectId, session.sessionId)).toBe(false))
  })
})
