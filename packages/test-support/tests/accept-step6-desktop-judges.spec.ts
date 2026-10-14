/**
 * The D24–D27 judges of accept-step6 (step6-desktop-judges.mjs) against a
 * hand-made observation in the shape the step-6 desktop scenario collects, and
 * copies broken in the ways each judge exists to catch. No model is called, no
 * app is started.
 */
import { describe, expect, it } from 'vitest'
import { judgeD24, judgeD25, judgeD26, judgeD27 } from '../../../scripts/accept-common/step6-desktop-judges.mjs'
import type { Step6DesktopObservations } from '../../../scripts/accept-common/step6-desktop.mjs'

type Obs = Step6DesktopObservations
const CHILD = 'c'.repeat(64)
const CHILD_SHORT = 'c'.repeat(12)
const PARENT_PARAGRAPH = 'You are the diagnosis step of Nexgent\'s improvement job.'
const CHILD_PARAGRAPH = 'Before naming a failure, read every failed check of the task and quote its output.'
const IDS = { j1: 'job-1', j2: 'job-2', seeded: 'job-meta-seeded', j3: 'job-3', real: 'job-meta-real', j4: 'job-4', j5: 'job-5', j6: 'job-6', auto: 'job-meta-auto' }
const REASON = '子改进器的诊断太慢'
const T = { on: { enabled: true, every: 2, budget: 2_000_000, window: 15, share: false }, off: { enabled: false, every: 2, budget: 1_500_000, window: 20, share: true } }
const PID = 'p'.repeat(64)
const OTHER_PID = 'o'.repeat(64)
const MAIN_ROOT = '/work/project'
const OTHER_ROOT = '/work/reports'
const SHARED_NOTE = '改进器由所有项目共用：在这里采用或回滚，会影响每个项目之后开始的改进作业。'
const WORDS = {
  literal: '回放前已拒绝：候选含有原题的具体数值',
  similar: '同类题变差：候选在相似任务上通过的检查比现在少，已拒绝',
  original: '只在原题上验证过：项目里没有相似任务可验证，需要你批准',
}

const capability = (id: string, version: string | undefined, createdAt: string, status = 'no-proposal') => ({ id, kind: 'capability', trigger: 'explicit', status, improverVersion: version, improverScope: 'user', createdAt, arm: false })
const meta = (id: string, version: string, createdAt: string, trigger = 'explicit', status = 'no-proposal', extra: object = {}) => ({ id, kind: 'meta', trigger, status, improverVersion: version, improverScope: 'user', createdAt, arm: false, meta: { parentVersion: version, basis: 3, ...extra } })
const card = (job: { id: string; kind: string; status: string; improverVersion?: string }) => ({
  id: job.id, kind: job.kind, status: job.status, badge: job.kind === 'meta', badgeText: job.kind === 'meta' ? '元改进' : null,
  improverVersion: job.improverVersion ?? 'v0', improverScope: 'user', improverText: `改进器 ${(job.improverVersion ?? 'v0').slice(0, 12)} · 用户级`, cost: '≈ $0.00 · 104 tokens', child: null,
})
const adopt = { revision: 1, type: 'adopt', version: CHILD, from: 'v0', trigger: 'meta-job', jobId: IDS.seeded, committedAt: '2026-10-13T10:00:00.000Z' }
const rollback = { revision: 2, type: 'rollback', version: 'v0', from: CHILD, trigger: 'manual', reason: REASON, committedAt: '2026-10-13T10:10:00.000Z' }
const improverDom = (version: string, revision: string, revisions: object[]) => ({ present: true, version, revision, versionText: version.slice(0, 12), problem: null, sharedNote: SHARED_NOTE, revisions, metaStatus: '元改进 关 · 已计入 2 / 3 个已结束作业', metaBudget: '元改进预算 378,000 / 6,000,000 tokens（30 天内）', rollbackButton: version !== 'v0' })
const queue = (pending: string[] = [], counted: string[] = []) => ({ projectId: PID, counted: counted.map(id => `${PID}:${id}`), pending: pending.map(jobId => ({ projectId: PID, jobId })), activeJobId: undefined as string | undefined })
const cfg = (s: { enabled: boolean; every: number; budget: number; window: number }) => ({ enabled: s.enabled, every: s.every, budget: s.budget, window: s.window })
const projectCfg = (share: boolean) => ({ share, meta: undefined as unknown })
/** The files of a snapshot: user config (`<home>/config.json`) and project config (`.nexgent/config.json`) are separate. */
const files = (jobs: object[], q: ReturnType<typeof queue>, revisions: object[], user: ReturnType<typeof cfg>, share = true) => ({ jobs, queue: q, revisions, userConfig: user, projectConfig: projectCfg(share), legacyProjectImprovers: false })
const configs = (user: ReturnType<typeof cfg>, share: boolean) => ({ user, project: projectCfg(share) })

function armFile(side: 'parent' | 'child') {
  return side === 'parent'
    ? { arm: 'parent', improverVersion: 'v0', candidateId: 'aaaaaaaa-0000', status: 'rejected', verdictOutcome: 'reject', verdictReason: 'similar-regression', quality: 0.5, usd: 0.52, tokens: 126000 }
    : { arm: 'child', improverVersion: CHILD, candidateId: 'bbbbbbbb-1111', status: 'adopted', verdictOutcome: 'adopt', verdictReason: 'quality-up', quality: 1, usd: 0.61, tokens: 126000 }
}
const armDom = (side: 'parent' | 'child') => side === 'parent'
  ? { arm: 'parent', version: '改进器 v0', offspring: '后代：aaaaaaaa', gate: `门控：未通过（${WORDS.similar}）`, quality: '质量：50%', cost: '费用：≈ $0.52 · 126,000 tokens' }
  : { arm: 'child', version: `改进器 ${CHILD_SHORT}`, offspring: '后代：bbbbbbbb', gate: '门控：通过（检查通过率高于基线）', quality: '质量：100%', cost: '费用：≈ $0.61 · 126,000 tokens' }

const gateCard = (job: object) => ({ job, decisionId: 'dec', candidateId: 'cand' })
const LITERALS = [
  { value: '2384.13', path: 'skill/region-table/SKILL.md', source: 'feedback:0b7a6c1e' },
  { value: '2026-09', path: 'skill/region-table/SKILL.md', source: 'deliverable:4f2d/v2/regions.csv' },
]

/** The three ADR 0013 conclusions as the last launch observes them. */
function gates() {
  const gateJob = (id: string, status: string) => ({ id, kind: 'capability', trigger: 'explicit', status, improverVersion: 'v0', improverScope: 'user', createdAt: '2026-10-13T12:00:00.000Z', arm: false })
  const base = { improverVersion: 'v0' }
  return [
    {
      key: 'literal', reason: 'instance-literal', outcome: 'rejected', summary: '地区表带均价', literals: LITERALS, similar: undefined, jobId: 'gate-literal', candidateId: 'cand-1', candidateVersion: 'a1'.repeat(32), decisionId: 'dec',
      dom: {
        status: 'rejected', scope: 'user',
        verdict: `未采用：${WORDS.literal}。The candidate carries values of its feedback task (2384.13, 2026-09); rejected before any replay.`,
        refused: '回放前已拒绝', literalsTitle: '', literals: LITERALS.map(hit => `${hit.value} · 文件 ${hit.path} · 来源 ${hit.source}`), similarRate: null, originalOnly: null, passRate: null, feedbackRate: null,
      },
      files: { ...gateCard(gateJob('gate-literal', 'rejected')), decision: { outcome: 'rejected', reason: 'instance-literal', detail: 'The candidate carries values of its feedback task (2384.13, 2026-09); rejected before any replay.', literals: LITERALS, similar: undefined, passRate: undefined, feedbackPassRate: undefined } },
      ...base,
    },
    {
      key: 'similar', reason: 'similar-regression', outcome: 'rejected', summary: '表格按首列排序', literals: undefined, similar: { candidate: 0.5, baseline: 1 }, jobId: 'gate-similar', candidateId: 'cand-2', candidateVersion: 'b2'.repeat(32), decisionId: 'dec',
      dom: {
        status: 'rejected', scope: 'user',
        verdict: `未采用：${WORDS.similar}。Similar cases (1) passed: candidate 50%, baseline 100%; rejected.`,
        refused: null, literalsTitle: null, literals: [], similarRate: '同类题通过率：候选 50%，现在 100%', originalOnly: null, passRate: '检查通过率 候选 75% / 基线 50%', feedbackRate: '反馈检查（单独记）候选 100% / 基线 0%',
      },
      files: { ...gateCard(gateJob('gate-similar', 'rejected')), decision: { outcome: 'rejected', reason: 'similar-regression', detail: 'Similar cases (1) passed: candidate 50%, baseline 100%; rejected.', literals: [], similar: { candidate: 0.5, baseline: 1 }, passRate: { candidate: 0.75, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 } } },
    },
    {
      key: 'original', reason: 'no-similar-cases', outcome: 'awaiting-approval', summary: '列名带单位', literals: undefined, similar: undefined, jobId: 'gate-original', candidateId: 'cand-3', candidateVersion: 'c3'.repeat(32), decisionId: 'dec',
      dom: {
        status: 'awaiting-approval', scope: 'user',
        verdict: `等待审批：${WORDS.original}。Checked on the feedback task only; waits for approval.`,
        refused: null, literalsTitle: null, literals: [], similarRate: null, originalOnly: '只在原题上验证过项目里没有相似任务，这个候选只在反馈对应的原任务上检查过，没有在同类题上验证，所以等你决定是否采用。', passRate: '检查通过率 候选 100% / 基线 50%', feedbackRate: '反馈检查（单独记）候选 100% / 基线 0%',
      },
      files: { ...gateCard(gateJob('gate-original', 'awaiting-approval')), decision: { outcome: 'awaiting-approval', reason: 'no-similar-cases', detail: 'Checked on the feedback task only; waits for approval.', literals: [], similar: undefined, passRate: { candidate: 1, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 } } },
    },
  ]
}

function good(): Obs {
  const j1 = capability(IDS.j1, 'v0', '2026-10-13T09:00:00.000Z')
  const seeded = meta(IDS.seeded, 'v0', '2026-10-13T09:01:00.000Z', 'job-count', 'adopted', { childVersion: CHILD, outcome: 'adopt', reason: 'gate-passed', revision: 1 })
  const j2 = capability(IDS.j2, CHILD, '2026-10-13T09:02:00.000Z')
  const initialFiles = files([j1, seeded, j2], queue([IDS.j1, IDS.j2], [IDS.j1, IDS.j2]), [adopt], cfg(T.off), true)
  const j3 = capability(IDS.j3, 'v0', '2026-10-13T10:11:00.000Z')
  const real = meta(IDS.real, 'v0', '2026-10-13T10:12:00.000Z')
  const finalFiles = files([j1, seeded, j2, j3, real], queue(), [adopt, rollback], cfg(T.off))
  const cardsOf = (jobs: any[]) => jobs.map(card)
  const afterRollbackFiles = { ...finalFiles, jobs: [j1, seeded, j2] }
  const j4 = capability(IDS.j4, 'v0', '2026-10-13T11:00:00.000Z')
  const j5 = capability(IDS.j5, 'v0', '2026-10-13T11:01:00.000Z')
  const onFlag = cfg({ ...T.off, enabled: true })
  const control = {
    configEnabled: true,
    before: files([j1, seeded, j2, j3, real, j4, j5], queue([IDS.j4, IDS.j5], [IDS.j4, IDS.j5]), [adopt, rollback], onFlag),
    started: IDS.auto,
    ran: { id: IDS.j6, status: 'no-proposal' },
    after: files([j1, seeded, j2, j3, real, capability(IDS.j4, 'v0', 'x'), capability(IDS.j5, 'v0', 'x'), capability(IDS.j6, 'v0', '2026-10-13T11:02:00.000Z'), meta(IDS.auto, 'v0', '2026-10-13T11:03:00.000Z', 'job-count', 'no-proposal', { basis: 3 })], queue([IDS.j6], [IDS.j4, IDS.j5, IDS.j6]), [adopt, rollback], onFlag),
  }
  const offBefore = files([j1, seeded, j2, j3, real], queue(), [adopt, rollback], cfg(T.off))
  const offAfter = files([...offBefore.jobs, j4, j5], queue([IDS.j4, IDS.j5], [IDS.j4, IDS.j5]), [adopt, rollback], cfg(T.off))
  const settingsDom = (s: typeof T.on) => ({ metaInUserSection: true, enabled: s.enabled, every: String(s.every), budget: String(s.budget), window: String(s.window), share: s.share })
  const otherSeed = { ...capability('job-other-1', CHILD, '2026-10-13T09:03:00.000Z') }
  const otherNextJob = meta('job-other-2', 'v0', '2026-10-13T10:15:00.000Z')
  const gateList = gates()
  return {
    consoleErrors: { first: [], second: [], third: [], fourth: [] },
    seeded: { jobId: IDS.seeded, child: CHILD, revision: 1, other: { root: OTHER_ROOT, name: 'reports', jobId: otherSeed.id, version: CHILD }, gates: gateList.map(({ dom, files: f, ...rest }) => rest), what: 'meta job record and the child improver revision written by the scenario through ImproverStore.user; a second project\'s job on the child; three gate conclusions' },
    prepared: { j1: { id: IDS.j1 }, j2: { id: IDS.j2 } },
    errors: {},
    d24: {
      initial: { cards: cardsOf(initialFiles.jobs), improver: improverDom(CHILD, '1', [{ type: 'adopt', version: CHILD, text: '#1 采用' }]), files: initialFiles },
      later: { cards: cardsOf(finalFiles.jobs), improver: improverDom('v0', '2', []), files: finalFiles },
    },
    d25: {
      seeded: {
        jobId: IDS.seeded, child: CHILD, parentParagraph: PARENT_PARAGRAPH,
        dom: {
          diagnosis: '元诊断假设：诊断策略没有要求先读失败的检查。结论：改进器需要一处修改诊断常漏读失败的检查（诊断 · 2 个作业）',
          findings: [{ stage: 'diagnose', text: '诊断常漏读失败的检查（诊断 · 2 个作业）' }],
          change: { op: 'set-diagnosis-paragraph', before: PARENT_PARAGRAPH, after: CHILD_PARAGRAPH, rationale: '理由：让诊断先读失败的检查。' },
          comparison: { arms: [armDom('parent'), armDom('child')], verdict: { outcome: 'adopt', reason: 'gate-passed', text: '结论：采用子版本（子的后代通过门控而父的没有）' } },
          cost: '元改进作业费用：费用未知 · 378,000 tokens',
          phases: [{ phase: 'meta-diagnose', text: '元诊断：126,000 tokens' }, { phase: 'meta-propose', text: '改进器提案：126,000 tokens' }, { phase: 'compare', text: '父子对比：126,000 tokens' }],
        },
        files: {
          job: seeded,
          diagnosis: { hypothesis: '诊断策略没有要求先读失败的检查。', proposal: 'change', findings: [{ stage: 'diagnose', label: '诊断常漏读失败的检查', jobs: 2 }] },
          change: { op: 'set-diagnosis-paragraph', index: 0, text: CHILD_PARAGRAPH, rationale: '让诊断先读失败的检查。', parentVersion: 'v0', childVersion: CHILD, childParagraph: CHILD_PARAGRAPH },
          comparison: { parent: armFile('parent'), child: armFile('child'), outcome: 'adopt', reason: 'gate-passed' },
          ledger: { requests: 0, phases: [] },
        },
      },
      real: {
        jobId: IDS.real,
        dom: { diagnosis: '元诊断假设：No improver problem is visible.结论：无', findings: [], change: null, comparison: null, cost: '元改进作业费用：≈ $0.00 · 104 tokens', phases: [{ phase: 'meta-diagnose', text: '元诊断：104 tokens' }] },
        files: { job: real, diagnosis: { hypothesis: 'No improver problem is visible.', proposal: 'none', findings: [] }, ledger: { requests: 2, phases: ['meta-diagnose'], tokens: 104 } },
      },
      gates: gateList,
      approval: {
        text: `候选需要你的批准×只在原题上验证过项目里没有相似任务，这个候选只在反馈对应的原任务上检查过。能力包哈希：${gateList[2]!.candidateVersion}列名带单位拒绝允许并采用`,
        originalOnly: gateList[2]!.dom.originalOnly,
        hash: gateList[2]!.candidateVersion,
      },
    },
    d26: {
      typed: T,
      initial: { metaInUserSection: true, enabled: false, every: '3', budget: '6000000', window: '30', share: true },
      configBefore: { user: { enabled: undefined, every: undefined, budget: undefined, window: undefined }, project: projectCfg(true) },
      saveOn: { approvalDialogs: 0 },
      saveShareOff: { approvalDialogs: 0 },
      configOn: configs(cfg(T.on), false),
      screenOn: { metaStatus: '元改进 开 · 已计入 2 / 2 个已结束作业', metaBudget: '元改进预算 378,000 / 2,000,000 tokens（15 天内）' },
      restartOn: settingsDom(T.on),
      configAfterRestartOn: configs(cfg(T.on), false),
      saveOff: { approvalDialogs: 0 },
      saveShareOn: { approvalDialogs: 0 },
      configOff: configs(cfg(T.off), true),
      restartOff: settingsDom(T.off),
      configAfterRestartOff: configs(cfg(T.off), true),
      screenOff: { metaStatus: '元改进 关 · 已计入 0 / 2 个已结束作业', metaBudget: '元改进预算 378,000 / 1,500,000 tokens（20 天内）' },
      filesAtRestart: files(offBefore.jobs, queue(), [adopt, rollback], cfg(T.off)),
      autoOff: { ran: [{ id: IDS.j4, status: 'no-proposal' }, { id: IDS.j5, status: 'no-proposal' }], before: offBefore, after: offAfter },
      control,
    },
    d27: {
      reason: REASON,
      before: initialFiles,
      mainBefore: { root: MAIN_ROOT, name: 'project', jobs: initialFiles.jobs },
      otherBefore: { root: OTHER_ROOT, name: 'reports', jobs: [otherSeed] },
      confirmation: {
        text: '最近使用过当前改进器的项目project · 10-13 09:02reports · 10-13 09:03',
        projects: [{ text: 'project · 10-13 09:02', root: MAIN_ROOT }, { text: 'reports · 10-13 09:03', root: OTHER_ROOT }],
      },
      afterImprover: improverDom('v0', '2', [{ type: 'rollback', version: 'v0', text: `#2 已回滚 → v0手动 · 10-13 10:10 · ${REASON}` }, { type: 'adopt', version: CHILD, text: '#1 采用' }]),
      after: afterRollbackFiles,
      next: [{ via: 'deliverable-improve', id: IDS.j3 }, { via: 'improvement-run-meta', id: IDS.real }],
      otherNext: { via: 'sdk improvements.runMeta', id: otherNextJob.id, root: OTHER_ROOT, status: 'no-proposal' },
      otherFinal: { root: OTHER_ROOT, name: 'reports', jobs: [otherSeed, otherNextJob] },
      final: { improver: improverDom('v0', '2', []), files: finalFiles, cards: cardsOf(finalFiles.jobs) },
    },
  }
}

function broken(change: (obs: any) => void): Obs {
  const obs = structuredClone(good()) as any
  change(obs)
  return obs
}

describe('D24: improver version on every job, a marker on meta jobs', () => {
  it('passes the good observation and says what was seeded', () => {
    const result = judgeD24(good())
    expect(result.status).toBe('passed')
    expect(result.evidence).toContain('seeded:')
  })

  it.each<[string, (o: any) => void]>([
    ['the version shown on a card is not the one in job.json', o => { o.d24.initial.cards[2].improverVersion = 'v0'; o.d24.initial.cards[2].improverText = '改进器 v0' }],
    ['a card text names another version than its data attribute', o => { o.d24.initial.cards[2].improverText = '改进器 v0' }],
    ['a meta job card lacks the marker', o => { o.d24.initial.cards[1].badge = false }],
    ['a capability job card carries the marker', o => { o.d24.initial.cards[0].badge = true }],
    ['a meta job card is not marked as meta', o => { o.d24.later.cards[4].kind = 'capability' }],
    ['a job file has no card', o => { o.d24.later.cards.pop() }],
    ['the improver section shows a version that is not the chain\'s tail', o => { o.d24.initial.improver.version = 'v0'; o.d24.initial.improver.versionText = 'v0' }],
    ['a card shows the version in force, not the pinned one', o => { o.d24.initial.cards[1].improverVersion = CHILD; o.d24.initial.cards[1].improverText = `改进器 ${CHILD_SHORT}` }],
    ['no look after the later jobs', o => { delete o.d24.later }],
    ['no meta job started by the product', o => { o.d24.later.files.jobs = o.d24.later.files.jobs.filter((j: any) => j.id !== IDS.real); o.d24.later.cards = o.d24.later.cards.filter((c: any) => c.id !== IDS.real) }],
    ['a card shows the project scope', o => { o.d24.initial.cards[0].improverScope = 'project'; o.d24.initial.cards[0].improverText = '改进器 v0' }],
    ['a card text omits the scope', o => { o.d24.later.cards[3].improverText = '改进器 v0' }],
    ['a card says user scope but its job file does not', o => { o.d24.initial.files.jobs[0].improverScope = undefined }],
    ['the shared note is missing', o => { o.d24.initial.improver.sharedNote = null }],
    ['the shared note says something else', o => { o.d24.later.improver.sharedNote = '改进器属于这个项目。' }],
    ['the project has an improvers directory of its own', o => { o.d24.later.files.legacyProjectImprovers = true }],
    ['a console error', o => { o.consoleErrors.first = ['boom'] }],
    ['the scenario crashed in the item', o => { o.errors.d24 = 'Error: page closed' }],
  ])('fails when %s', (_name, change) => {
    expect(judgeD24(broken(change)).status).toBe('failed')
  })

  it('fails without observations', () => {
    expect(judgeD24(undefined).status).toBe('failed')
    expect(judgeD24({}).status).toBe('failed')
  })
})

describe('D25: meta job detail', () => {
  it('passes the good observation', () => {
    expect(judgeD25(good()).status).toBe('passed')
  })

  it.each<[string, (o: any) => void]>([
    ['an arm\'s cost differs from comparison.json', o => { o.d25.seeded.dom.comparison.arms[1].cost = '费用：≈ $0.99 · 126,000 tokens' }],
    ['an arm\'s token count differs from comparison.json', o => { o.d25.seeded.dom.comparison.arms[0].cost = '费用：≈ $0.52 · 1 tokens' }],
    ['an arm\'s quality differs from comparison.json', o => { o.d25.seeded.dom.comparison.arms[1].quality = '质量：80%' }],
    ['an arm\'s offspring differs', o => { o.d25.seeded.dom.comparison.arms[1].offspring = '后代：deadbeef' }],
    ['a child arm shows the parent\'s improver version', o => { o.d25.seeded.dom.comparison.arms[1].version = '改进器 v0' }],
    ['an arm\'s gate result contradicts its record', o => { o.d25.seeded.dom.comparison.arms[0].gate = '门控：通过（检查通过率高于基线）' }],
    ['only one arm is shown', o => { o.d25.seeded.dom.comparison.arms.pop() }],
    ['the decision outcome differs from comparison.json', o => { o.d25.seeded.dom.comparison.verdict.outcome = 'reject'; o.d25.seeded.dom.comparison.verdict.text = '结论：不采用（没有改进）' }],
    ['the decision reason differs from job.json', o => { o.d25.seeded.files.job.meta.reason = 'quality-up' }],
    ['the decision text omits the reason', o => { o.d25.seeded.dom.comparison.verdict.text = '结论：采用子版本' }],
    ['the change-after text is not change.json\'s', o => { o.d25.seeded.dom.change.after = 'something else' }],
    ['the change-before text is not the parent\'s paragraph', o => { o.d25.seeded.dom.change.before = CHILD_PARAGRAPH }],
    ['the child improver file does not hold the change', o => { o.d25.seeded.files.change.childParagraph = 'other' }],
    ['the meta diagnosis hypothesis is not shown', o => { o.d25.seeded.dom.diagnosis = '元诊断结论：改进器需要一处修改' }],
    ['a finding\'s stage differs', o => { o.d25.seeded.dom.findings[0].stage = 'trial' }],
    ['no comparison section', o => { o.d25.seeded.dom.comparison = null }],
    ['no change section', o => { o.d25.seeded.dom.change = null }],
    ['the adopt revision of the job is missing', o => { o.d24.initial.files.revisions = [] }],
    ['the cost line is missing', o => { o.d25.seeded.dom.cost = null }],
    ['the real meta job\'s tokens differ from the ledger', o => { o.d25.real.files.ledger.tokens = 52 }],
    ['the real meta job shows an unknown cost', o => { o.d25.real.dom.cost = '元改进作业费用：费用未知 · 104 tokens' }],
    ['the real meta job has no ledger requests', o => { o.d25.real.files.ledger = { requests: 0, phases: [], tokens: 0 } }],
    ['the real meta job shows a comparison it does not have', o => { o.d25.real.dom.comparison = { arms: [], verdict: null } }],
    ['no real meta job detail', o => { delete o.d25.real }],
    ['an arm\'s gate shows the raw reason id', o => { o.d25.seeded.dom.comparison.arms[0].gate = '门控：未通过（similar-regression）' }],
    ['an arm\'s gate shows another reason\'s words', o => { o.d25.seeded.dom.comparison.arms[0].gate = '门控：未通过（检查通过率低于基线）' }],
    ['the scenario crashed in the item', o => { o.errors.d25 = 'Error: timeout' }],
    ['a gate conclusion was not opened', o => { o.d25.gates.pop() }],
    ['no gate conclusions at all', o => { delete o.d25.gates }],
    ['no approval dialog observed', o => { delete o.d25.approval }],
    ['a console error in the launch that showed the conclusions', o => { o.consoleErrors.fourth = ['boom'] }],
    ['an observed gate job is not a seeded one', o => { o.d25.gates[1].jobId = 'someone-elses' }],
    ['the literal conclusion shows the raw reason id', o => { o.d25.gates[0].dom.verdict = o.d25.gates[0].dom.verdict.replace(WORDS.literal, 'instance-literal') }],
    ['the literal conclusion drops the decision\'s detail', o => { o.d25.gates[0].dom.verdict = `未采用：${WORDS.literal}。` }],
    ['the literal conclusion shows another reason\'s words', o => { o.d25.gates[0].dom.verdict = o.d25.gates[0].dom.verdict.replace(WORDS.literal, WORDS.similar) }],
    ['the refusal before replay is not said', o => { o.d25.gates[0].dom.refused = null }],
    ['a value found is not listed', o => { o.d25.gates[0].dom.literals.pop() }],
    ['a value found is listed without its file', o => { o.d25.gates[0].dom.literals[0] = '2384.13 · 来源 feedback:0b7a6c1e' }],
    ['a value found is listed without its source', o => { o.d25.gates[0].dom.literals[1] = '2026-09 · 文件 skill/region-table/SKILL.md' }],
    ['a value shown is not the one found', o => { o.d25.gates[0].dom.literals[0] = o.d25.gates[0].dom.literals[0].replace('2384.13', '9.99') }],
    ['the decision record holds other values than the seed', o => { o.d25.gates[0].files.decision.literals[0].value = '9.99' }],
    ['the literal conclusion shows a similar-case rate', o => { o.d25.gates[0].dom.similarRate = '同类题通过率：候选 50%，现在 100%' }],
    ['the decision record of the literal job says another reason', o => { o.d25.gates[0].files.decision.reason = 'quality-down' }],
    ['the gate job card is not the user-level improver\'s', o => { o.d25.gates[0].dom.scope = 'project' }],
    ['the card status differs from job.json', o => { o.d25.gates[0].dom.status = 'adopted' }],
    ['the similar conclusion shows the raw reason id', o => { o.d25.gates[1].dom.verdict = o.d25.gates[1].dom.verdict.replace(WORDS.similar, 'similar-regression') }],
    ['the similar conclusion shows no similar-case rate', o => { o.d25.gates[1].dom.similarRate = null }],
    ['the similar-case rates are swapped', o => { o.d25.gates[1].dom.similarRate = '同类题通过率：候选 100%，现在 50%' }],
    ['the similar-case rate shows only the candidate', o => { o.d25.gates[1].dom.similarRate = '同类题通过率：候选 50%' }],
    ['the overall pass rate differs from the record', o => { o.d25.gates[1].dom.passRate = '检查通过率 候选 90% / 基线 50%' }],
    ['the similar rate in the record is not worse', o => { o.d25.gates[1].files.decision.similar = { candidate: 1, baseline: 1 }; o.d25.gates[1].dom.similarRate = '同类题通过率：候选 100%，现在 100%' }],
    ['the similar conclusion lists literals', o => { o.d25.gates[1].dom.literals = ['1 · 文件 a · 来源 b'] }],
    ['the original-only conclusion shows the raw reason id', o => { o.d25.gates[2].dom.verdict = o.d25.gates[2].dom.verdict.replace(WORDS.original, 'no-similar-cases') }],
    ['the detail does not say verified on the original case only', o => { o.d25.gates[2].dom.originalOnly = null }],
    ['the original-only job is not waiting', o => { o.d25.gates[2].files.job.status = 'rejected'; o.d25.gates[2].dom.status = 'rejected' }],
    ['the original-only job shows a similar-case rate', o => { o.d25.gates[2].dom.similarRate = '同类题通过率：候选 50%，现在 100%' }],
    ['the approval dialog lacks the original-only note', o => { o.d25.approval.originalOnly = null }],
    ['the approval dialog says something else about the candidate', o => { o.d25.approval.originalOnly = '需要你的批准' }],
    ['the approval dialog is for another candidate', o => { o.d25.approval.hash = 'f'.repeat(64) }],
    ['the approval dialog is not the approval title', o => { o.d25.approval.text = '插件审批' }],
  ])('fails when %s', (_name, change) => {
    expect(judgeD25(broken(change)).status).toBe('failed')
  })
})

describe('D26: meta settings, kept across restarts, off means no automatic meta job', () => {
  it('passes the good observation', () => {
    const result = judgeD26(good())
    expect(result.status).toBe('passed')
    expect(result.evidence).toContain('no meta job started')
  })

  it.each<[string, (o: any) => void]>([
    ['the config file does not hold what was typed', o => { o.d26.configOn.user.budget = 6_000_000 }],
    ['the budget is lost after the restart (page)', o => { o.d26.restartOn.budget = '6000000' }],
    ['the switch is lost after the restart (page)', o => { o.d26.restartOn.enabled = false }],
    ['the window is lost after the restart (config)', o => { o.d26.configAfterRestartOn.user.window = 30 }],
    ['the off state is lost after the second restart', o => { o.d26.restartOff.enabled = true }],
    ['the second restart shows the first budget', o => { o.d26.restartOff.budget = String(T.on.budget) }],
    ['saving asked for an approval', o => { o.d26.saveOn.approvalDialogs = 1 }],
    ['the meta settings were written to the project config', o => { o.d26.configOn.project.meta = { enabled: true, everyJobs: 2 } }],
    ['the meta settings are in the project config only', o => { o.d26.configOn.project.meta = { enabled: true }; o.d26.configOn.user = cfg({ enabled: false, every: 3, budget: 6_000_000, window: 30 }) }],
    ['the sharing switch was not saved to the project config', o => { o.d26.configOn.project.share = true }],
    ['the sharing switch is lost after the restart (page)', o => { o.d26.restartOn.share = true }],
    ['the sharing switch is lost after the restart (config)', o => { o.d26.configAfterRestartOn.project.share = true }],
    ['sharing is not switched back on', o => { o.d26.configOff.project.share = false }],
    ['the second restart shows sharing off', o => { o.d26.restartOff.share = false }],
    ['the meta controls are not in the user section', o => { o.d26.restartOn.metaInUserSection = false }],
    ['the meta controls were not in the user section from the start', o => { o.d26.initial.metaInUserSection = false }],
    ['saving the sharing switch asked for an approval', o => { o.d26.saveShareOff.approvalDialogs = 1 }],
    ['the project did not share by default', o => { o.d26.initial.share = false }],
    ['the project config had no sharing before', o => { o.d26.configBefore.project.share = false }],
    ['the project config holds a meta key during the off run', o => { o.d26.autoOff.after.projectConfig.meta = { enabled: false } }],
    ['the project stopped sharing during the off run', o => { o.d26.autoOff.after.projectConfig.share = false }],
    ['the user queue counted by job id only', o => { o.d26.autoOff.after.queue.counted = [IDS.j4, IDS.j5] }],
    ['the control switched on the project config, not the user config', o => { o.d26.control.after.projectConfig.meta = { enabled: true }; o.d26.control.after.userConfig.enabled = false }],
    ['the 改进 tab does not follow the saved setting', o => { o.d26.screenOn.metaStatus = '元改进 关 · 已计入 2 / 2 个已结束作业' }],
    ['the tab\'s budget is not the saved one', o => { o.d26.screenOn.metaBudget = '元改进预算 378,000 / 6,000,000 tokens（30 天内）' }],
    ['the tab\'s count differs from the queue', o => { o.d26.screenOff.metaStatus = '元改进 关 · 已计入 5 / 2 个已结束作业' }],
    ['a meta job started while the switch was off', o => { o.d26.autoOff.after.jobs.push(meta('job-meta-sneaky', 'v0', '2026-10-13T11:02:00.000Z', 'job-count', 'meta-diagnosing')) }],
    ['the finished jobs were not counted', o => { o.d26.autoOff.after.queue = queue() }],
    ['fewer finished jobs than K', o => { o.d26.autoOff.ran.pop(); o.d26.autoOff.after.queue = queue([IDS.j4], [IDS.j4]) }],
    ['the config says on during the off run', o => { o.d26.autoOff.after.userConfig.enabled = true }],
    ['the control (switch on) started nothing', o => { o.d26.control.after.jobs = o.d26.control.after.jobs.slice(0, -1); o.d26.control.started = 'nothing' }],
    ['the control meta job was not started by the job-count rule', o => { o.d26.control.after.jobs[8].trigger = 'explicit' }],
    ['no control observation', o => { delete o.d26.control }],
    ['console errors after a restart', o => { o.consoleErrors.second = ['boom'] }],
    ['the scenario crashed in the item', o => { o.errors.d26 = 'Error: no settings page' }],
  ])('fails when %s', (_name, change) => {
    expect(judgeD26(broken(change)).status).toBe('failed')
  })
})

describe('D27: rollback in the UI, the next job uses the rolled-back version', () => {
  it('passes the good observation', () => {
    const result = judgeD27(good())
    expect(result.status).toBe('passed')
    expect(result.evidence).toContain('revision #2')
  })

  it.each<[string, (o: any) => void]>([
    ['no new revision was written', o => { o.d27.after.revisions = [adopt] }],
    ['the rollback rewrote an earlier revision', o => { o.d27.after.revisions[0] = { ...adopt, version: 'd'.repeat(64) } }],
    ['the new revision is an adoption, not a rollback', o => { o.d27.after.revisions[1] = { ...rollback, type: 'adopt', trigger: 'meta-job' } }],
    ['the rollback trigger is not manual', o => { o.d27.after.revisions[1] = { ...rollback, trigger: 'load-failure' } }],
    ['the reason was not written', o => { o.d27.after.revisions[1] = { ...rollback, reason: undefined } }],
    ['the rollback went to another version', o => { o.d27.after.revisions[1] = { ...rollback, version: 'e'.repeat(64) } }],
    ['the screen still shows the child', o => { o.d27.afterImprover.version = CHILD }],
    ['the screen shows a stale revision count', o => { o.d27.afterImprover.revision = '1' }],
    ['the next capability job pinned the child', o => { o.d27.final.files.jobs[3].improverVersion = CHILD }],
    ['the next meta job pinned the child', o => { o.d27.final.files.jobs[4].improverVersion = CHILD; o.d27.final.cards[4].improverVersion = CHILD }],
    ['a job created after the rollback pins the child', o => { o.d27.final.files.jobs.push(capability('job-late', CHILD, '2026-10-13T10:30:00.000Z')) }],
    ['the next job\'s card shows another version than job.json', o => { o.d27.final.cards[3].improverVersion = CHILD }],
    ['the next jobs were not started after the rollback', o => { o.d27.final.files.jobs[3].createdAt = '2026-10-13T09:30:00.000Z' }],
    ['the job before the rollback did not pin the child (rollback proves nothing)', o => { o.d27.final.files.jobs[2].improverVersion = 'v0' }],
    ['only one next job was observed', o => { o.d27.next.pop() }],
    ['no next job is a meta job', o => { o.d27.next[1].id = IDS.j3 }],
    ['the child was not in force before', o => { o.d27.before.revisions = [] }],
    ['the final improver on disk is not v0', o => { o.d27.final.files.revisions.push({ revision: 3, type: 'adopt', version: CHILD, from: 'v0', trigger: 'meta-job', committedAt: '2026-10-13T10:20:00.000Z' }) }],
    ['the scenario crashed in the item', o => { o.errors.d27 = 'Error: confirm button missing' }],
    ['the confirmation lists only this project', o => { o.d27.confirmation.projects.pop() }],
    ['the confirmation lists a project that did not use the child', o => { o.d27.confirmation.projects.push({ text: 'orders · 10-13 09:04', root: '/work/orders' }) }],
    ['the confirmation lists the wrong project', o => { o.d27.confirmation.projects[1].root = '/work/orders'; o.d27.confirmation.projects[1].text = 'orders · 10-13 09:03' }],
    ['the confirmation does not name its subject', o => { o.d27.confirmation.text = 'project · 10-13 09:02reports · 10-13 09:03' }],
    ['the other project did not run on the child (the list proves nothing)', o => { o.d27.otherBefore.jobs[0].improverVersion = 'v0' }],
    ['the other project\'s job was not on the user line', o => { o.d27.otherBefore.jobs[0].improverScope = 'project' }],
    ['the other project\'s next job pins the child', o => { o.d27.otherFinal.jobs[1].improverVersion = CHILD }],
    ['the other project\'s next job is not on the user line', o => { o.d27.otherFinal.jobs[1].improverScope = 'project' }],
    ['the other project\'s next job was created before the rollback', o => { o.d27.otherFinal.jobs[1].createdAt = '2026-10-13T09:30:00.000Z' }],
    ['the other project\'s next job did not finish', o => { o.d27.otherFinal.jobs[1].status = 'meta-diagnosing' }],
    ['the other project\'s next job is missing', o => { delete o.d27.otherNext }],
    ['the other project\'s earlier job was rewritten', o => { o.d27.otherFinal.jobs[0].improverVersion = 'v0' }],
    ['the rollback landed in the project\'s own improvers directory', o => { o.d27.after.legacyProjectImprovers = true }],
    ['a next job\'s card shows the project scope', o => { o.d27.final.cards[3].improverScope = 'project' }],
    ['a next job is not on the user line', o => { o.d27.final.files.jobs[3].improverScope = undefined }],
  ])('fails when %s', (_name, change) => {
    expect(judgeD27(broken(change)).status).toBe('failed')
  })
})
