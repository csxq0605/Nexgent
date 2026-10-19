import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@nexgent/kernel'
import {
  approvalChoices,
  createApprovalResponder,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  formatApprovalPrompt,
  parseApprovalAnswer,
} from '../src/index.js'
import { Capture, SID } from './helpers.js'

const request: ApprovalRequest = {
  id: 'ap-1',
  sessionId: SID,
  callId: 'call_1',
  tool: 'bash',
  summary: 'pnpm install',
  detail: 'cwd: /proj\nrule: blacklisted command',
  risk: 'medium',
  options: ['once', 'session', 'project'],
  pattern: 'pnpm install',
}

function tty() {
  const input = Object.assign(new PassThrough(), { isTTY: true })
  const output = Object.assign(new Capture(), { isTTY: true })
  return { input, output }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseApprovalAnswer', () => {
  it.each([
    ['a', { decision: 'allow', scope: 'once' }],
    [' S ', { decision: 'allow', scope: 'session' }],
    ['project', { decision: 'allow', scope: 'project' }],
    ['d', { decision: 'deny' }],
    ['no', { decision: 'deny' }],
    ['', undefined],
    ['maybe', undefined],
  ])('%j', (line, expected) => {
    expect(parseApprovalAnswer(line, ['once', 'session', 'project'])).toEqual(expected)
  })

  it('refuses scopes the request does not offer', () => {
    expect(parseApprovalAnswer('s', ['once'])).toBeUndefined()
    expect(parseApprovalAnswer('d', ['once'])).toEqual({ decision: 'deny' })
  })
})

describe('prompt text', () => {
  it('shows summary, detail, risk, pattern and the offered choices', () => {
    expect(formatApprovalPrompt(request, DEFAULT_APPROVAL_TIMEOUT_MS)).toBe([
      'nexgent: approval needed [medium risk] bash',
      '  pnpm install',
      '  cwd: /proj',
      '  rule: blacklisted command',
      '  a session / project grant would cover: pnpm install',
      '[a]llow once / [s]ession / [p]roject / [d]eny (300 s)? ',
    ].join('\n'))
    expect(approvalChoices(['once'])).toBe('[a]llow once / [d]eny')
  })
})

describe('createApprovalResponder', () => {
  it('denies at once with decidedBy headless when not on a TTY', async () => {
    const output = new Capture()
    const respond = createApprovalResponder({ input: new PassThrough(), output })
    expect(await respond(request, new AbortController().signal)).toEqual({ id: 'ap-1', decision: 'deny', scope: 'once', decidedBy: 'headless' })
    expect(output.text).toBe('')
  })

  it('allows with the chosen scope after re-asking on a bad answer', async () => {
    const { input, output } = tty()
    let prompted = 0
    const respond = createApprovalResponder({ input, output, beforePrompt: () => { prompted += 1 } })
    const pending = respond(request, new AbortController().signal)
    input.write('x\r\n')
    input.write('s\n')
    expect(await pending).toEqual({ id: 'ap-1', decision: 'allow', scope: 'session', decidedBy: 'user' })
    expect(prompted).toBe(1)
    expect(output.text).toContain('please answer [a]llow once / [s]ession / [p]roject / [d]eny: ')
  })

  it('records a user deny', async () => {
    const { input, output } = tty()
    const respond = createApprovalResponder({ input, output })
    const pending = respond(request, new AbortController().signal)
    input.write('d\n')
    expect(await pending).toMatchObject({ decision: 'deny', scope: 'once', decidedBy: 'user' })
  })

  it('denies with decidedBy timeout when nobody answers', async () => {
    vi.useFakeTimers()
    const { input, output } = tty()
    const respond = createApprovalResponder({ input, output })
    const pending = respond(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(DEFAULT_APPROVAL_TIMEOUT_MS - 1)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ decision: 'deny', decidedBy: 'timeout' })
    expect(output.text).toContain('no answer within 300 s; denied')
  })

  it('honours a shorter timeout and an earlier expiresAt', async () => {
    const { input, output } = tty()
    const respond = createApprovalResponder({ input, output, timeoutMs: 20 })
    expect(await respond(request, new AbortController().signal)).toMatchObject({ decidedBy: 'timeout' })
    const now = Date.now()
    const respond2 = createApprovalResponder({ input, output, timeoutMs: 60_000, now: () => now })
    const expired = { ...request, expiresAt: new Date(now + 10).toISOString() }
    expect(await respond2(expired, new AbortController().signal)).toMatchObject({ decidedBy: 'timeout' })
  })

  it('closes a pending prompt with decidedBy cancel when the turn is cancelled', async () => {
    const { input, output } = tty()
    const respond = createApprovalResponder({ input, output })
    const controller = new AbortController()
    const pending = respond(request, controller.signal)
    controller.abort('user')
    expect(await pending).toMatchObject({ decision: 'deny', decidedBy: 'cancel' })
    const already = new AbortController()
    already.abort()
    expect(await respond(request, already.signal)).toMatchObject({ decidedBy: 'cancel' })
  })

  it('denies when input closes', async () => {
    const { input, output } = tty()
    const respond = createApprovalResponder({ input, output })
    const pending = respond(request, new AbortController().signal)
    input.end()
    expect(await pending).toMatchObject({ decision: 'deny', decidedBy: 'headless' })
  })

  it('asks queued requests one at a time and keeps typed-ahead answers', async () => {
    const { input, output } = tty()
    const respond = createApprovalResponder({ input, output })
    const signal = new AbortController().signal
    const first = respond(request, signal)
    const second = respond({ ...request, id: 'ap-2', options: ['once'] }, signal)
    input.write('a\nd\n')
    expect(await first).toMatchObject({ id: 'ap-1', decision: 'allow', scope: 'once' })
    expect(await second).toMatchObject({ id: 'ap-2', decision: 'deny', decidedBy: 'user' })
    expect(output.text.match(/approval needed/g)).toHaveLength(2)
  })
})
