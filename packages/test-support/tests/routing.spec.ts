import { afterEach, describe, expect, it } from 'vitest'
import type { LLMRequest, LLMStreamEvent } from '@nexgent/kernel'
import { EXECUTION_FORMS, renderMemberPromptLine, type MemberExecutionForm } from '@nexgent/kernel'
import {
  llmSessionText,
  routeByMember,
  routeByText,
  scriptedModelServer,
  scriptedProvider,
  sessionText,
  type MessagesRequestBody,
  type ScriptedModelServer,
} from '../src/index.js'

function request(system: string, user: string, extra: LLMRequest['messages'] = []): LLMRequest {
  return {
    requestId: `${system}-${extra.length}`,
    model: 'scripted-model',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }, ...extra],
    thinking: 'off',
  }
}

async function text(stream: AsyncIterable<LLMStreamEvent>): Promise<string> {
  let out = ''
  for await (const event of stream) {
    if (event.type === 'text.delta') out += event.text
    if (event.type === 'error') out += `[error: ${event.error.message}]`
  }
  return out
}

const byMember = routeByText<LLMRequest>(llmSessionText, { alpha: 'member alpha', beta: 'member beta' })

describe('scriptedProvider routing', () => {
  it('answers each session from its own queue whatever the interleaving', async () => {
    for (const order of [['alpha', 'beta', 'beta', 'alpha'], ['beta', 'alpha', 'alpha', 'beta'], ['alpha', 'alpha', 'beta', 'beta']]) {
      const provider = scriptedProvider([{ content: 'lead-1' }], {
        routeKey: byMember,
        routes: { alpha: [{ content: 'a-1' }, { content: 'a-2' }], beta: [{ content: 'b-1' }, { content: 'b-2' }] },
      })
      const seen: Record<string, string[]> = { alpha: [], beta: [] }
      for (const member of order) {
        const turns = seen[member]!.length
        seen[member]!.push(await text(provider.complete(request(`you are member ${member}`, 'task', turns === 0 ? [] : [{ role: 'assistant', content: 'x' }]))))
      }
      expect(seen).toEqual({ alpha: ['a-1', 'a-2'], beta: ['b-1', 'b-2'] })
      expect(await text(provider.complete(request('you are the lead', 'go')))).toBe('lead-1')
      expect(provider.calls.map((c) => c.route)).toEqual([...order, undefined])
      provider.assertConsumed()
    }
  })

  it('is deterministic when sessions stream concurrently', async () => {
    const provider = scriptedProvider([], {
      chunkDelayMs: 2,
      routeKey: byMember,
      routes: {
        alpha: [{ content: ['a', '-', '1'] }, { content: ['a', '-', '2'] }],
        beta: [{ content: ['b', '-', '1'] }, { content: ['b', '-', '2'] }],
      },
    })
    const session = async (member: string): Promise<string[]> => {
      const first = await text(provider.complete(request(`member ${member}`, 'task')))
      const second = await text(provider.complete(request(`member ${member}`, 'task', [{ role: 'assistant', content: first }])))
      return [first, second]
    }
    const [alpha, beta] = await Promise.all([session('alpha'), session('beta')])
    expect(alpha).toEqual(['a-1', 'a-2'])
    expect(beta).toEqual(['b-1', 'b-2'])
  })

  it('a global queue is order-dependent (why routing exists)', async () => {
    const provider = scriptedProvider([{ content: 'meant-for-alpha' }, { content: 'meant-for-beta' }])
    expect(await text(provider.complete(request('member beta', 'task')))).toBe('meant-for-alpha')
  })

  it('routes on the session-identifying text only, not on later turns', async () => {
    const provider = scriptedProvider([{ content: 'lead' }], { routeKey: byMember, routes: { alpha: [{ content: 'alpha' }] } })
    const leadSeesMember = request('you are the lead', 'go', [{ role: 'assistant', content: 'delegating' }, { role: 'user', content: 'member alpha finished' }])
    expect(await text(provider.complete(leadSeesMember))).toBe('lead')
    expect(provider.remainingByRoute()).toEqual({ '': 0, alpha: 1 })
  })

  it('names the route when its queue is exhausted, and in assertConsumed', async () => {
    const provider = scriptedProvider([{ content: 'left' }], { routeKey: byMember, routes: { alpha: [], beta: [{ content: 'b' }] } })
    expect(await text(provider.complete(request('member alpha', 'task')))).toMatch(/script for route "alpha" exhausted at request #1/)
    expect(provider.remaining).toBe(2)
    expect(() => provider.assertConsumed()).toThrow(/2 script entries not consumed \(\(default\): 1, beta: 1\)/)
  })

  it('pushTo creates or extends a route queue; routes need routeKey', async () => {
    const provider = scriptedProvider([], { routeKey: byMember })
    provider.pushTo('beta', { content: 'b-late' })
    expect(await text(provider.complete(request('member beta', 'task')))).toBe('b-late')
    expect(() => scriptedProvider([], { routes: { alpha: [] } })).toThrow(/needs a `routeKey`/)
    expect(() => scriptedProvider([]).pushTo('alpha', { content: 'x' })).toThrow(/needs a `routeKey`/)
  })

  it('an unknown or absent key falls back to the default script', async () => {
    const provider = scriptedProvider([{ content: 'default' }], { routeKey: () => 'gamma', routes: { alpha: [{ content: 'a' }] } })
    expect(await text(provider.complete(request('member gamma', 'task')))).toBe('default')
    expect(provider.calls[0]!.route).toBeUndefined()
  })
})

describe('routeByText', () => {
  it('matches in insertion order and resets global RegExps', () => {
    const key = routeByText<string>((s) => s, { first: /member-\d/g, second: 'member' })
    expect(key('member-1')).toBe('first')
    expect(key('member-2')).toBe('first')
    expect(key('member')).toBe('second')
    expect(key('nobody')).toBeUndefined()
  })
})

describe('routeByMember', () => {
  it('reads the kernel member line for every execution form; root sessions have none', async () => {
    const key = routeByMember<LLMRequest>(llmSessionText)
    for (const form of EXECUTION_FORMS.filter((f): f is MemberExecutionForm => f !== 'direct')) {
      const system = `You are Nexgent.\n${renderMemberPromptLine({ name: 'checker-2', executionForm: form })}\nRules follow.`
      expect(key(request(system, 'task')), form).toBe('checker-2')
    }
    expect(key(request('You are Nexgent.', 'task'))).toBeUndefined()
    // A lead quoting a member line in a later turn stays on the default script.
    expect(key(request('You are Nexgent.', 'go', [{ role: 'user', content: renderMemberPromptLine({ name: 'alpha', executionForm: 'delegated' }) }]))).toBeUndefined()
    // The line must stand alone, not be embedded in prose.
    expect(key(request('see Member: alpha (delegated) below', 'task'))).toBeUndefined()

    const provider = scriptedProvider([{ content: 'lead' }], { routeKey: key, routes: { alpha: [{ content: 'alpha' }] } })
    expect(await text(provider.complete(request(renderMemberPromptLine({ name: 'alpha', executionForm: 'delegated' }), 'task')))).toBe('alpha')
    expect(await text(provider.complete(request('root', 'task')))).toBe('lead')
  })
})

describe('scriptedModelServer routing', () => {
  let server: ScriptedModelServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function ask(system: string, extra: MessagesRequestBody['messages'] = []): Promise<{ status: number; text: string }> {
    const res = await fetch(`${server!.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 10, system, messages: [{ role: 'user', content: 'task' }, ...extra ?? []] }),
    })
    const body = await res.json() as { content?: Array<{ text?: string }>; error?: { message: string } }
    return { status: res.status, text: body.content?.map((b) => b.text ?? '').join('') ?? body.error?.message ?? '' }
  }

  it('answers concurrent sessions from their own queues and records the route', async () => {
    server = await scriptedModelServer({
      chunkDelayMs: 1,
      script: [{ content: 'lead' }],
      routeKey: routeByText(sessionText, { alpha: 'member alpha', beta: 'member beta' }),
      routes: { alpha: [{ content: 'a-1' }, { content: 'a-2' }], beta: [{ content: 'b-1' }, { content: 'b-2' }] },
    })
    const session = async (member: string): Promise<string[]> => {
      const first = await ask(`you are member ${member}`)
      const second = await ask(`you are member ${member}`, [{ role: 'assistant', content: first.text }, { role: 'user', content: 'member alpha said hi' }])
      return [first.text, second.text]
    }
    const [alpha, beta] = await Promise.all([session('alpha'), session('beta')])
    expect(alpha).toEqual(['a-1', 'a-2'])
    expect(beta).toEqual(['b-1', 'b-2'])
    expect((await ask('lead', [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'member beta done' }])).text).toBe('lead')
    expect(server.requests.filter((r) => r.route === 'beta')).toHaveLength(2)
    expect(server.requests[server.requests.length - 1]!.route).toBeUndefined()
    server.assertConsumed()
  })

  it('reports an exhausted route with 500 and keeps other queues', async () => {
    server = await scriptedModelServer({
      routeKey: routeByText(sessionText, { alpha: 'alpha' }),
      routes: { alpha: [] },
      script: [{ content: 'unused' }],
    })
    const res = await ask('alpha')
    expect(res.status).toBe(500)
    expect(res.text).toMatch(/script for route "alpha" exhausted at request #1/)
    expect(server.requests[0]!.outcome).toBe('exhausted')
    server.pushTo('alpha', { content: 'now' })
    expect((await ask('alpha')).text).toBe('now')
    expect(() => server!.assertConsumed()).toThrow(/\(default\): 1/)
  })
})
