import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NexgentError, type Context, type ImproverBundle, type ImproverChangeRecord, type ImproverComparison, type ImproverRevision, type MetaDiagnosis } from '@nexgent/kernel'
import { EvolvePlugin, type EvolvePluginConfig, type StartedJob } from '@nexgent/evolve'
import type { ImprovementDetail, ImprovementJobView, ImproverDetail, ImproverListing } from '@nexgent/sdk'
import {
  EXIT, formatChange, formatComparison, formatDetail, formatImproverDetail, formatImproverListing, formatListing, formatMetaDiagnosis,
  main, parseCliArgs, resolveImproverVersion, shortVersion, type CliDeps,
} from '../src/index.js'
import { testIo } from './helpers.js'

const V1 = 'a'.repeat(12) + '1'.repeat(52)
const V2 = 'a'.repeat(12) + '2'.repeat(52)
const V3 = 'b'.repeat(64)
const JOB = 'dddddddd-1111-4111-8111-111111111111'

const bundle: ImproverBundle = {
  formatVersion: 1,
  diagnosis: { paragraphs: ['Find out why.', 'Classify each failure.', 'Cite evidence.', 'Report once.'] },
  proposal: { kinds: ['skill', 'preset'], briefs: { skill: 'brief', preset: 'brief' } },
  comparison: { selectionCases: 3, repeats: 2, selection: 'recency' },
}

const revision = (n: number, from: string, version: string, over: Partial<ImproverRevision> = {}): ImproverRevision => ({
  format: 1, revision: n, previous: null, from, version, type: 'adopt', trigger: 'meta-job', jobId: JOB, committedAt: '2026-10-13T09:12:00.000Z', ...over,
})

const history = [revision(1, 'v0', V1), revision(2, V1, V2), revision(3, V2, V1, { type: 'rollback', trigger: 'manual', reason: 'worse in practice' })]

const listing: ImproverListing = {
  current: { version: V1, revision: 3, since: '2026-10-13T09:12:00.000Z', trigger: 'manual' },
  history,
}

const change: ImproverChangeRecord = {
  formatVersion: 1, jobId: JOB, createdAt: '2026-10-13T09:00:00.000Z', sessionId: 's', attempts: 1,
  parentVersion: 'v0', childVersion: V1,
  change: { op: 'set-comparison-param', param: 'selectionCases', value: 3 }, rationale: 'more cases give a steadier gate',
}

const arm = (which: 'parent' | 'child', version: string, over: Record<string, unknown> = {}) => ({
  arm: which, improverVersion: version, origin: { kind: 'unresolved', sourceJobId: 'eeeeeeee-2222-4222-8222-222222222222', tree: 't', feedbackIds: [], capabilityVersion: 'v0', epoch: 'e' },
  jobId: JOB, status: 'adopted', candidateId: 'cand1',
  verdict: { outcome: 'adopt', reason: 'better', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 1, decidedByReview: false },
  cost: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 'unknown', cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestCount: 3, estimatedUsd: 0.5 },
  ...over,
})

const comparison = {
  formatVersion: 1, jobId: JOB, createdAt: '2026-10-13T09:30:00.000Z',
  origin: arm('parent', 'v0').origin,
  parent: arm('parent', 'v0'),
  child: arm('child', V1, { cost: { usage: { inputTokens: 'unknown', outputTokens: 1, totalTokens: 'unknown', cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestCount: 1, estimatedUsd: 'unknown' } }),
  verdict: { outcome: 'adopt', reason: 'quality-up', quality: { parent: 0.5, child: 1 }, costRatio: 1.25 },
} as unknown as ImproverComparison

const metaDiagnosis = {
  formatVersion: 1, jobId: JOB, createdAt: '', sessionId: 's', attempts: 1, improverVersion: 'v0', basis: [], statusCounts: {},
  hypothesis: 'the trial replays too few cases', proposal: 'change',
  findings: [{ stage: 'trial', label: 'flaky gate', jobIds: ['eeeeeeee-2222-4222-8222-222222222222'] }],
} as unknown as MetaDiagnosis

describe('args', () => {
  it('parses improvers actions and improve meta', () => {
    expect(parseCliArgs(['improvers', 'list', '--project', 'p'])).toEqual({ command: 'improvers', action: 'list', project: 'p', json: false })
    expect(parseCliArgs(['improvers', 'show', 'aaa', '--project', 'p', '--json'])).toMatchObject({ action: 'show', version: 'aaa', json: true })
    expect(parseCliArgs(['improvers', 'rollback', '--project', 'p', '--to', 'v0', '--reason', 'bad'])).toMatchObject({ action: 'rollback', to: 'v0', reason: 'bad' })
    expect(parseCliArgs(['improvers', 'rollback', '--project', 'p'])).toEqual({ command: 'improvers', action: 'rollback', project: 'p', json: false })
    expect(parseCliArgs(['improve', 'meta', '--project', 'p'])).toEqual({ command: 'improve', action: 'meta', project: 'p', json: false })
    expect(() => parseCliArgs(['improvers', '--project', 'p'])).toThrow(/needs an action/)
    expect(() => parseCliArgs(['improvers', 'nope', '--project', 'p'])).toThrow(/unknown improvers action/)
    expect(() => parseCliArgs(['improvers', 'show', '--project', 'p'])).toThrow(/needs a <version>/)
    expect(() => parseCliArgs(['improvers', 'list', '--project', 'p', '--to', 'v0'])).toThrow(/does not accept --to/)
    expect(() => parseCliArgs(['improvers', 'rollback', 'x', '--project', 'p'])).toThrow(/no positional/)
    expect(() => parseCliArgs(['improve', 'meta', '--project', 'p', '--session', 's'])).toThrow(/does not accept --session/)
    expect(() => parseCliArgs(['improve', 'list', '--project', 'p', '--to', 'v0'])).toThrow(/does not accept --to/)
  })
})

describe('formatting', () => {
  it('shortens versions and resolves prefixes', () => {
    expect(shortVersion(V1)).toBe('a'.repeat(12))
    expect(shortVersion('v0')).toBe('v0')
    const known = ['v0', V1, V2, V3]
    expect(resolveImproverVersion(known, V1)).toBe(V1)
    expect(resolveImproverVersion(known, 'bbbb')).toBe(V3)
    expect(resolveImproverVersion(known, 'v0')).toBe('v0')
    expect(() => resolveImproverVersion(known, 'aaaa')).toThrow(/ambiguous/)
    expect(() => resolveImproverVersion(known, 'ffff')).toThrow(/no improver version/)
  })

  it('renders the listing and one version', () => {
    const text = formatImproverListing(listing)
    for (const part of [
      `current: ${'a'.repeat(12)}`, 'revision: 3', 'since: 2026-10-13 09:12Z', 'trigger: manual',
      `#1 adopt v0 -> ${'a'.repeat(12)}, meta-job, job dddddddd, 2026-10-13 09:12Z`, '#3 rollback', 'manual', ': worse in practice',
    ]) expect(text).toContain(part)
    expect(text).not.toContain(V1)
    expect(formatImproverListing({ current: { version: 'v0', revision: 0 }, history: [] })).toContain('history: none')

    const detail: ImproverDetail = { version: V1, bundle, change, current: true }
    const shown = formatImproverDetail(detail)
    for (const part of [
      `Improver ${V1}`, 'current: yes', 'diagnosis: 4 paragraphs', '- Find out why.', '... 1 more', 'proposal kinds: skill, preset',
      'comparison: 3 selection cases, 2 repeats, selection recency', 'produced by:', 'change: set-comparison-param', 'selectionCases = 3',
      `version: v0 -> ${'a'.repeat(12)}`, 'rationale: more cases give a steadier gate',
    ]) expect(shown).toContain(part)
    expect(formatImproverDetail({ version: 'v0', bundle, current: false })).toContain('current: no')
  })

  it('renders a meta job: diagnosis, change, comparison', () => {
    const text = [...formatMetaDiagnosis(metaDiagnosis), ...formatChange(change), ...formatComparison(comparison)].join('\n')
    for (const part of [
      'hypothesis: the trial replays too few cases', 'proposal: change', 'finding (trial): flaky gate [jobs: eeeeeeee]',
      'change: set-comparison-param', 'rationale: more cases',
      'comparison: unresolved origin, job eeeeeeee', 'parent: improver v0, status adopted, candidate cand1',
      'gate: adopt (better); pass rate candidate 100% vs baseline 50%', 'cost: 120 tokens, ≈ $0.50',
      'child: improver aaaaaaaaaaaa', 'cost: unknown tokens, unknown', 'verdict: adopt (quality-up); quality parent 50% child 100%; cost ratio 1.25',
    ]) expect(text).toContain(part)
  })

  it('shows kind and improver version in the job list and detail', () => {
    const view = (over: Partial<ImprovementJobView>): ImprovementJobView => ({
      id: JOB, trigger: 'meta-every', status: 'adopted', createdAt: '2026-10-13T09:12:00.000Z', updatedAt: '', itemCount: 0,
      feedbackIds: [], phaseTimes: {}, tokens: {}, estimatedUsd: 0, ...over,
    } as ImprovementJobView)
    const text = formatListing({
      jobs: [view({ kind: 'meta', improverVersion: V1 }), view({ id: 'cccccccc-3333-4333-8333-333333333333', trigger: 'explicit' })],
      pending: 0, threshold: 5, budget: { usedTokens: 0, maxTokens: 10, windowDays: 7 }, autoImprove: true,
      meta: { enabled: true, pending: 2, everyJobs: 5, budget: { usedTokens: 7, maxTokens: 100, windowDays: 7 } },
    })
    expect(text).toContain('meta: on, 2/5 finished jobs counted, budget 7/100 tokens (7 days)')
    expect(text).toMatch(/dddddddd {2}meta {2}adopted {2}meta-every {2}aaaaaaaaaaaa {2}2026-10-13 09:12Z/)
    expect(text).toMatch(/cccccccc {2}job {2}adopted {2}explicit {2}v0 {2}2026-10-13/)

    const detail = {
      view: view({ kind: 'meta', improverVersion: 'v0', meta: { childVersion: V1, outcome: 'adopt', reason: 'quality-up' } }),
      job: { id: JOB, status: 'adopted', trigger: 'meta-every', items: [], history: [{ status: 'queued', at: '2026-10-13T09:12:00.000Z' }] },
      metaDiagnosis, change, comparison,
    } as unknown as ImprovementDetail
    const shown = formatDetail(detail)
    for (const part of [`Improvement job ${JOB} (meta)`, 'improver: v0', 'meta diagnosis:', 'change: set-comparison-param', 'origin, job', 'verdict: adopt (quality-up)']) {
      expect(shown).toContain(part)
    }
    expect(formatDetail({ ...detail, comparison: undefined } as unknown as ImprovementDetail)).toContain('meta outcome: adopt (quality-up)')
  })
})

describe('commands through a fake SDK', () => {
  let work: string
  let project: string
  let calls: Array<{ method: string; input: unknown }>
  let failWith: NexgentError | undefined

  beforeEach(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-improvers-'))
    project = path.join(work, 'project')
    await fs.mkdir(project)
    calls = []
    failWith = undefined
  })
  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 })
  })

  const metaJob = { id: JOB, kind: 'meta', trigger: 'explicit', status: 'queued', createdAt: '', updatedAt: '', itemCount: 0, feedbackIds: [], phaseTimes: {}, tokens: {}, estimatedUsd: 0 }

  function deps(): CliDeps {
    return {
      createSdk: () => ({
        async call(method: string, input: unknown) {
          calls.push({ method, input })
          if (failWith !== undefined && method !== 'projects.open') throw failWith
          switch (method) {
            case 'projects.open': return { projectId: 'p1' }
            case 'improvements.runMeta': return metaJob
            case 'improvements.list': return { jobs: [] }
            case 'improvers.list': return listing
            case 'improvers.show': {
              const { version } = input as { version: string }
              if (version !== V1 && version !== 'v0') throw new NexgentError('improver/not-found', `no improver ${version}`)
              return { version, bundle, current: version === V1, ...(version === V1 ? { change } : {}) }
            }
            case 'improvers.rollback': return { version: 'v0', revision: 4, trigger: 'manual', since: '2026-10-13T10:00:00.000Z' }
            default: throw new Error(`unexpected ${method}`)
          }
        },
        async dispose() {},
      }) as never,
    }
  }

  async function run(args: string[], env: Record<string, string> = { NEXGENT_API_KEY: 'k', NEXGENT_HOME: path.join(work, 'home') }) {
    const t = testIo(work, env)
    const code = await main([...args, '--project', project], t.io, { ...deps(), credentials: { env, home: path.join(work, 'home') } })
    return { code, out: t.stdout.text, err: t.stderr.text }
  }

  it('improve meta: starts a meta job; busy and exhausted exit 1; no key exits 3', async () => {
    const ok = await run(['improve', 'meta'])
    expect(ok.code, ok.err).toBe(EXIT.OK)
    expect(ok.out).toContain(`meta improvement job ${JOB} started (queued); it runs in the background.`)
    expect(calls.map(c => c.method)).toEqual(['projects.open', 'improvements.runMeta'])
    const json = await run(['improve', 'meta', '--json'])
    expect((JSON.parse(json.out) as { type: string; job: { kind: string } })).toMatchObject({ type: 'improve.meta', job: { kind: 'meta' } })

    failWith = new NexgentError('improvement/busy', 'busy', { details: { jobId: JOB } })
    const busy = await run(['improve', 'meta'])
    expect(busy.code).toBe(EXIT.TASK_FAILED)
    expect(busy.err).toContain('already running')
    failWith = new NexgentError('improvement/budget-exhausted', 'meta budget spent')
    const spent = await run(['improve', 'meta'])
    expect(spent.code).toBe(EXIT.TASK_FAILED)
    expect(spent.err).toContain('budget is spent')

    const noKey = await run(['improve', 'meta'], {})
    expect(noKey.code).toBe(EXIT.ENVIRONMENT)
  })

  it('improvers list / show / rollback', async () => {
    const list = await run(['improvers', 'list'])
    expect(list.code, list.err).toBe(EXIT.OK)
    expect(list.out).toContain('#2 adopt')
    const json = JSON.parse((await run(['improvers', 'list', '--json'])).out) as { type: string; current: { version: string } }
    expect(json).toMatchObject({ type: 'improvers.list', current: { version: V1 } })

    const shown = await run(['improvers', 'show', 'aaaaaaaaaaaa1'])
    expect(shown.code, shown.err).toBe(EXIT.OK)
    expect(shown.out).toContain(`Improver ${V1}`)
    expect(calls.at(-1)).toEqual({ method: 'improvers.show', input: { projectId: 'p1', version: V1 } })
    const v0 = await run(['improvers', 'show', 'v0', '--json'])
    expect(JSON.parse(v0.out)).toMatchObject({ type: 'improvers.show', version: 'v0', current: false })

    const ambiguous = await run(['improvers', 'show', 'aaaa'])
    expect(ambiguous.code).toBe(EXIT.USAGE)
    expect(ambiguous.err).toContain('ambiguous')
    const unknown = await run(['improvers', 'show', 'ffff'])
    expect(unknown.code).toBe(EXIT.ENVIRONMENT)
    expect(unknown.err).toContain('no improver version "ffff"')

    const back = await run(['improvers', 'rollback', '--to', 'v0', '--reason', 'worse'])
    expect(back.code, back.err).toBe(EXIT.OK)
    expect(back.out).toContain('version v0 is now in force (revision 4)')
    expect(calls.at(-1)).toEqual({ method: 'improvers.rollback', input: { projectId: 'p1', toVersion: 'v0', reason: 'worse' } })
    await run(['improvers', 'rollback'])
    expect(calls.at(-1)).toEqual({ method: 'improvers.rollback', input: { projectId: 'p1' } })
  })

  it('an SDK-side improver/not-found exits 3', async () => {
    failWith = new NexgentError('improver/not-found', 'no improver x')
    const r = await run(['improvers', 'rollback'])
    expect(r.code).toBe(EXIT.ENVIRONMENT)
  })
})

describe('commands through the real SDK', () => {
  let work: string
  let project: string
  let home: string
  beforeEach(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-improvers-'))
    project = path.join(work, 'project')
    home = path.join(work, 'home')
    await fs.mkdir(project)
    await fs.mkdir(home)
  })
  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 })
  })

  /** Never starts a job process (it would reach the real model API). */
  const launched: string[] = []
  const realDeps = (): CliDeps => ({
    sdkOptions: {
      registry: {
        [EvolvePlugin.name]: {
          ...EvolvePlugin,
          apply(ctx: Context, config: EvolvePluginConfig = {}) {
            EvolvePlugin.apply(ctx, { ...config, launch: (_layout, jobId): StartedJob => { launched.push(jobId); return { jobId, pid: undefined, exited: Promise.resolve(0) } } })
          },
        },
      },
    },
  })
  const run = async (args: string[]) => {
    const t = testIo(work, { NEXGENT_API_KEY: 'k', NEXGENT_HOME: home })
    const code = await main([...args, '--project', project], t.io, realDeps())
    return { code, out: t.stdout.text, err: t.stderr.text }
  }

  it('a fresh project: v0 listed and shown; rollback has nowhere to go; improve meta starts a meta job on v0', async () => {
    const list = await run(['improvers', 'list', '--json'])
    expect(list.code, list.err).toBe(EXIT.OK)
    expect(JSON.parse(list.out)).toMatchObject({ type: 'improvers.list', current: { version: 'v0', revision: 0 }, history: [] })
    const show = await run(['improvers', 'show', 'v0', '--json'])
    expect(show.code, show.err).toBe(EXIT.OK)
    expect(JSON.parse(show.out)).toMatchObject({ type: 'improvers.show', version: 'v0', current: true })
    const back = await run(['improvers', 'rollback'])
    expect(back.code).not.toBe(EXIT.OK)
    const meta = await run(['improve', 'meta', '--json'])
    expect(meta.code, meta.err).toBe(EXIT.OK)
    const { job } = JSON.parse(meta.out) as { job: ImprovementJobView }
    expect(job).toMatchObject({ kind: 'meta', trigger: 'explicit', status: 'queued' })
    expect(launched).toContain(job.id)
    const listed = await run(['improve', 'list'])
    expect(listed.out).toMatch(/meta: off, 0\/3 finished jobs counted/)
    expect(listed.out).toContain(`${job.id.slice(0, 8)}  meta  queued`)
  })
})
