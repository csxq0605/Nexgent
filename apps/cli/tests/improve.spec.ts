import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@nexgent/kernel'
import { createJob, EvolvePlugin, ensureQueue, startExplicitJob, transitionJob, type EvolvePluginConfig, type StartedJob } from '@nexgent/evolve'
import type { ImprovementDetail, ImprovementJobView } from '@nexgent/sdk'
import {
  billedTokensOf, EXIT, formatCost, formatDetail, formatListing, formatRunNote, main, parseCliArgs, resolveJobId, type CliDeps,
} from '../src/index.js'
import { FakeRuntime, testIo, writeFileTurn } from './helpers.js'

let work: string
let project: string
let home: string
let launched: string[]
let dir: string

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-improve-'))
  project = path.join(work, 'project')
  home = path.join(work, 'home')
  await fs.mkdir(project)
  await fs.mkdir(home)
  dir = path.join(project, '.nexgent', 'improvements')
  launched = []
})
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5 })
})

/** Never starts a job process (it would reach the real model API); records the ids instead. */
function deps(): CliDeps {
  return {
    sdkOptions: {
      registry: {
        [EvolvePlugin.name]: {
          ...EvolvePlugin,
          apply(ctx: Context, config: EvolvePluginConfig = {}) {
            EvolvePlugin.apply(ctx, {
              ...config,
              launch: (_layout, jobId): StartedJob => {
                launched.push(jobId)
                return { jobId, pid: undefined, exited: Promise.resolve(0) }
              },
            })
          },
        },
      },
    },
  }
}

const env = () => ({ NEXGENT_API_KEY: 'k', NEXGENT_HOME: home })

async function improve(args: string[], extra: Partial<CliDeps> = {}) {
  const t = testIo(work, env())
  const code = await main(['improve', ...args, '--project', project], t.io, { ...deps(), ...extra })
  return { code, out: t.stdout.text, err: t.stderr.text }
}

async function makeJob(id: string, now: string, final?: 'failed' | 'diagnosing', detail?: string) {
  await createJob(dir, { id, trigger: 'feedback-count', items: [], now: new Date(now) })
  if (final === 'failed') {
    await transitionJob(dir, id, 'diagnosing', { now: new Date(now) })
    await transitionJob(dir, id, 'failed', { now: new Date(now), ...(detail === undefined ? {} : { detail }) })
  }
}

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'aaaabbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'

describe('args', () => {
  it('parses the improve actions and rejects misuse', () => {
    expect(parseCliArgs(['improve', 'list', '--project', 'p'])).toEqual({ command: 'improve', action: 'list', project: 'p', json: false })
    expect(parseCliArgs(['improve', 'show', 'abc', '--project', 'p', '--json'])).toMatchObject({ action: 'show', jobId: 'abc', json: true })
    expect(parseCliArgs(['improve', 'run', '--project', 'p', '--session', 's', '--deliverable', 'd'])).toMatchObject({ action: 'run', sessionId: 's', deliverableId: 'd' })
    expect(() => parseCliArgs(['improve', '--project', 'p'])).toThrow(/needs an action/)
    expect(() => parseCliArgs(['improve', 'nope', '--project', 'p'])).toThrow(/unknown improve action/)
    expect(() => parseCliArgs(['improve', 'show', '--project', 'p'])).toThrow(/needs a <jobId>/)
    expect(() => parseCliArgs(['improve', 'list', '--project', 'p', '--session', 's'])).toThrow(/does not accept --session/)
    expect(() => parseCliArgs(['run', '--project', 'p', '--task', 't', '--session', 's'])).toThrow(/does not accept --session/)
  })
})

describe('formatting', () => {
  const view = (over: Partial<ImprovementJobView>): ImprovementJobView => ({
    id: A, trigger: 'explicit', status: 'queued', createdAt: '2026-10-13T09:12:00.000Z', updatedAt: '2026-10-13T09:12:00.000Z',
    itemCount: 0, tokens: {}, estimatedUsd: 0, ...over,
  })

  it('sums tokens and marks unknown', () => {
    expect(billedTokensOf({ tokens: { diagnose: 10, propose: 5 } })).toBe(15)
    expect(billedTokensOf({ tokens: { diagnose: 10, propose: 'unknown' } })).toBe('unknown')
    expect(formatCost(0.123)).toBe('≈ $0.12')
    expect(formatCost('unknown')).toBe('unknown')
  })

  it('renders the end-of-run note only when there is a job', () => {
    expect(formatRunNote([])).toBeUndefined()
    const note = formatRunNote([view({ status: 'diagnosing' })])
    expect(note).toContain('aaaaaaaa diagnosing')
    expect(note).toContain('nexgent improve list')
  })

  it('renders a detail with diagnosis, candidate and gate verdict', () => {
    const detail = {
      view: view({ status: 'adopted', tokens: { diagnose: 100, trial: 'unknown' }, estimatedUsd: 'unknown' }),
      job: {
        id: A, status: 'adopted', trigger: 'explicit', items: [1, 2],
        history: [{ status: 'queued', at: '2026-10-13T09:12:00.000Z' }, { status: 'adopted', at: '2026-10-13T10:00:00.000Z', detail: 'gate passed' }],
        firstUse: { taskId: 't1', sessionId: 's1', at: '2026-10-14T08:00:00.000Z', version: 'v2' },
        rolledBack: { decisionId: 'd9', at: '2026-10-15T08:00:00.000Z' },
      },
      diagnosis: { hypothesis: 'missing region column', proposalKind: 'skill', failureTypes: [{ category: 'task-verification', label: 'no region', evidence: [{}, {}] }] },
      candidate: {
        view: { id: 'cand1', status: 'adopted', components: [{ kind: 'skill', name: 'regions' }], decision: { outcome: 'adopt', reason: 'better', detail: 'ok' } },
        receipts: [{ type: 'trial.end', status: 'completed', verdict: { outcome: 'adopt', reason: 'better', passRate: { candidate: 1, baseline: 0.5 } } }],
      },
    } as unknown as ImprovementDetail
    const text = formatDetail(detail)
    for (const part of [
      'trigger: explicit, 2 items', 'adopted: gate passed', 'hypothesis: missing region column', 'proposal kind: skill',
      'failure (task-verification): no region [2 evidence records]', 'skill/regions', 'decision: adopt (better): ok',
      'gate: adopt (better); pass rate candidate 100% vs baseline 50%', 'diagnose 100, trial unknown', 'estimated cost: unknown',
      'first use: 2026-10-14 08:00Z in session s1', 'rolled back: 2026-10-15 08:00Z',
    ]) expect(text).toContain(part)
  })

  it('resolves ids and prefixes', () => {
    const jobs = [{ id: A }, { id: B }, { id: C }]
    expect(resolveJobId(jobs, C)).toBe(C)
    expect(resolveJobId(jobs, 'cc')).toBe(C)
    expect(() => resolveJobId(jobs, 'aaaa')).toThrow(/ambiguous/)
    expect(() => resolveJobId(jobs, 'zz')).toThrow(/no improvement job/)
    expect(formatListing({ jobs: [], pending: 0, threshold: 5, budget: { usedTokens: 0, maxTokens: 1, windowDays: 7 } })).toContain('No improvement jobs yet.')
  })
})

describe('nexgent improve', () => {
  it('list: empty state', async () => {
    await ensureQueue(dir)
    const r = await improve(['list'])
    expect(r.code, r.err).toBe(EXIT.OK)
    expect(r.out).toMatch(/^Improvement jobs: pending 0\/\d+ \| budget 0\/\d+ tokens in \d+ days\nNo improvement jobs yet\.\n$/)
  })

  it('list: jobs newest first with detail and unknown cost; --json', async () => {
    await ensureQueue(dir)
    await makeJob(A, '2026-10-12T08:00:00.000Z', 'failed', 'the model said no')
    // Created just now: a queued job older than evolve's start grace with no process would be recovered as interrupted.
    await makeJob(C, new Date().toISOString())
    const r = await improve(['list'])
    expect(r.code, r.err).toBe(EXIT.OK)
    const lines = r.out.trimEnd().split('\n').slice(1)
    expect(lines[0]).toMatch(/^cccccccc {2}queued {2}feedback-count {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z {2}0 tokens/)
    expect(lines[1]).toMatch(/^aaaaaaaa {2}failed /)
    expect(lines[2]).toBe('    the model said no')
    const json = await improve(['list', '--json'])
    const parsed = JSON.parse(json.out) as { type: string; jobs: Array<{ id: string }> }
    expect(parsed.type).toBe('improve.list')
    expect(parsed.jobs.map(job => job.id)).toEqual([C, A])
  })

  it('show: by prefix; ambiguous and unknown prefixes fail', async () => {
    await ensureQueue(dir)
    await makeJob(A, '2026-10-12T08:00:00.000Z', 'failed', 'boom')
    await makeJob(B, '2026-10-12T09:00:00.000Z', 'failed', 'bang')
    const ok = await improve(['show', 'aaaaaaaa'])
    expect(ok.code, ok.err).toBe(EXIT.OK)
    expect(ok.out).toContain(`Improvement job ${A}`)
    expect(ok.out).toContain('failed: boom')
    expect(ok.out).toContain('tokens: none yet')
    const ambiguous = await improve(['show', 'aaaa'])
    expect(ambiguous.code).toBe(EXIT.USAGE)
    expect(ambiguous.err).toContain('ambiguous')
    const unknown = await improve(['show', 'ffff'])
    expect(unknown.code).toBe(EXIT.ENVIRONMENT)
    expect(unknown.err).toContain('no improvement job "ffff"')
  })

  it('run: starts a job without a process, then reports busy', async () => {
    const first = await improve(['run'])
    expect(first.code, first.err).toBe(EXIT.OK)
    expect(first.out).toMatch(/^improvement job [0-9a-f-]{36} started \(queued\); it runs in the background\./)
    expect(first.out).toContain('nexgent improve list')
    expect(launched).toHaveLength(1)
    expect(first.out).toContain(launched[0] as string)

    const second = await improve(['run'])
    expect(second.code).toBe(EXIT.TASK_FAILED)
    expect(second.err).toContain('already running')
    expect(second.err).toContain(`nexgent improve cancel ${(launched[0] as string).slice(0, 8)}`)
    expect(launched).toHaveLength(1)
  })

  it('run: busy when the queue already holds an active job', async () => {
    await startExplicitJob(dir, {})
    const r = await improve(['run'])
    expect(r.code).toBe(EXIT.TASK_FAILED)
    expect(r.err).toContain('already running')
    expect(launched).toHaveLength(0)
  })

  it('run: exit 3 without an API key', async () => {
    const t = testIo(work, {})
    const code = await main(['improve', 'run', '--project', project], t.io, { ...deps(), credentials: { env: {}, home: path.join(work, 'no-home') } })
    expect(code).toBe(EXIT.ENVIRONMENT)
    expect(launched).toHaveLength(0)
  })

  it('cancel: by prefix', async () => {
    const started = await improve(['run', '--json'])
    const id = (JSON.parse(started.out) as { job: { id: string } }).job.id
    const r = await improve(['cancel', id.slice(0, 6)])
    expect(r.code, r.err).toBe(EXIT.OK)
    expect(r.out).toBe(`improvement job ${id} is now cancelled.\n`)
    const missing = await improve(['cancel', 'ffffffff'])
    expect(missing.code).toBe(EXIT.ENVIRONMENT)
  })
})

describe('end of run', () => {
  it('prints one line when a job started during the run, nothing otherwise', async () => {
    const t = testIo(work, env())
    const plain = new FakeRuntime(writeFileTurn())
    expect(await main(['run', '--project', project, '--task', 't'], t.io, { loadRuntime: async () => plain })).toBe(EXIT.OK)
    expect(t.stderr.text).not.toContain('improvement job')

    const job = { id: C, trigger: 'feedback-count', status: 'diagnosing', createdAt: '2026-10-13T09:12:00.000Z', updatedAt: '', itemCount: 3, tokens: {}, estimatedUsd: 0 } as unknown as ImprovementJobView
    const runtime = {
      async open(options: Parameters<FakeRuntime['open']>[0]) {
        const session = await new FakeRuntime(writeFileTurn()).open(options)
        return { ...session, improvementChanges: async () => [job] }
      },
    }
    const u = testIo(work, env())
    expect(await main(['run', '--project', project, '--task', 't'], u.io, { loadRuntime: async () => runtime })).toBe(EXIT.OK)
    expect(u.stderr.text).toContain('background improvement job cccccccc diagnosing')
    expect(u.stdout.text).not.toContain('improvement job')
  })
})
