/**
 * The step-6 acceptance checklist (docs/plan/step-6-work-partition.md
 * §`accept-step6` 检查项清单) as data, plus the pure pieces of the runner,
 * so they can be unit-tested (`packages/test-support/tests/accept-step6.spec.ts`).
 *
 * Same contract as steps 2–5: an entry with `run(ctx)` is implemented; an
 * entry without it is reported `not-implemented` — never a pass — and the
 * script exits 2. Item evaluation, the exit rule and the budget gate are
 * step 2's, re-exported unchanged.
 *
 * Regressions: H18 runs step 5's own headless items H01–H19 (H19 there is step
 * 4's, which re-runs step 3's) over fresh runs of their scenarios
 * (`ctx.regression`, the step-5 headless ctx); D01–D23 are step 5's desktop
 * items with their own scenarios and judges (the desktop ctx has step 5's shape).
 *
 * Round 3: the improver-version items run over step6-headless.mjs
 * (`ctx.step6`: H01 the step-5 projects on v0, H02 the improver store, H03 a
 * job pinned across an adoption), and the experiment items E01 / E04 over
 * step6-experiment.mjs (`ctx.sets`, `ctx.report`), judged by step6-judges.mjs.
 *
 * Round 4: the meta-improvement items H04–H17 over step6-meta.mjs (`ctx.step6Meta`:
 * a trigger project, an adopting and a rejecting comparison; H07 judges the
 * origin by ADR 0009), judged by step6-meta-judges.mjs; D24–D27 over
 * step6-desktop.mjs (`ctx.step6Desktop`), judged by step6-desktop-judges.mjs;
 * E02 / E03 over a scripted rehearsal of scripts/experiment/step6
 * (step6-rehearsal.mjs, `ctx.rehearsal`), judged by step6-rehearsal-judges.mjs.
 * Still not implemented: the real layer R01–R08.
 *
 * Step-6 rework, round 1 (ADR 0011–0013): skeleton items H19–H24 and
 * REWORK_EXPECTATIONS, the existing items whose expectations the new rules change.
 * Round 3 (R7 part 2): H19–H24 wired over step6-rework.mjs (`ctx.step6Rework`), judged
 * by step6-rework-judges.mjs; H01–H17 follow the user-level improver (ADR 0012) and
 * the adr-0016 rules (ADR 0014, 0015 and 0016 superseded adr-0013 in turn during this round); the seven `stale` items rewritten on the user's decision of
 * 2026-10-14 08:12 (H15, E03, R03–R07); E02 / E03 over the pilot's scripted rehearsal
 * (base / memory / parent, an own NEXGENT_HOME per arm); E04 adds the pilot's report.
 */
import { CHECKS as STEP5_CHECKS, evaluateItem } from './step5-checks.mjs'
import { DESKTOP_JUDGES } from './step6-desktop-judges.mjs'
import { judgePilotReport, judgePinned, judgeReport, judgeSets, judgeStore, judgeV0 } from './step6-judges.mjs'
import { META_JUDGES } from './step6-meta-judges.mjs'
import { REWORK_JUDGES } from './step6-rework-judges.mjs'
import { judgeHoldoutArms, judgeIsolation as judgeRehearsalIsolation } from './step6-rehearsal-judges.mjs'

export { budgetGate, decideExit, evaluateItem, EXIT_FAIL, EXIT_NOT_READY, EXIT_PASS } from './step2-checks.mjs'

/** Layers in run order. `real` is only run when asked for explicitly. */
export const LAYERS = /** @type {const} */ ({
  headless: { title: '无界面层（脚本化 provider，经 SDK）', prefix: 'H' },
  desktop: { title: '桌面层（脚本化 provider，Playwright 驱动 Electron；D01–D23 为步骤 2–5 回归，D24–D27 改进器）', prefix: 'D' },
  experiment: { title: '实验层（脚本化，scripts/experiment/step6，不调模型）', prefix: 'E' },
  real: { title: '真实模型层（手动）', prefix: 'R' },
})

/** Default layers when `--layer` is not given. */
export const DEFAULT_LAYERS = ['headless', 'desktop', 'experiment']

/** Real-model run facts (partition §真实模型实验; user decision 8, 2026-10-13: 35 USD for step 6). */
export const REAL_MODEL = {
  model: 'claude-sonnet-5-5',
  thinking: 'on',
  budgetUsd: 35,
  keyEnv: ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY'],
  task: 'scripts/experiment/step6/pilot (ADR 0011): two pilot families (documents, file organizing); dev / selection / guard / holdout; improver v0, no meta job; arms base / memory / parent, each with its own NEXGENT_HOME, holdout cases × 3 repeats',
  /** ADR 0011: the pilot's own gate, counted toward the step's 35 USD. */
  pilotGateUsd: 12,
}

/** Step 5's headless items, in order: what H18 re-runs. */
export const STEP5_HEADLESS = STEP5_CHECKS.filter(check => check.layer === 'headless')

/**
 * H18's verdict from step 5's per-item results: passed only when every one of
 * step 5's H01–H19 passed; otherwise failed, naming each item that did not pass.
 * @param results - `[id, { status, evidence }]` pairs.
 */
export function regressionVerdict(results) {
  const ids = STEP5_HEADLESS.map(check => check.id)
  const byId = new Map(results)
  const missing = ids.filter(id => !byId.has(id))
  const bad = ids.filter(id => byId.has(id) && byId.get(id).status !== 'passed')
  if (missing.length === 0 && bad.length === 0) return { status: 'passed', evidence: `step 5 ${ids[0]}–${ids.at(-1)}: all ${ids.length} passed (H19 there: step 4 H01–H19, with step 3)` }
  const lines = [
    ...missing.map(id => `${id} not judged`),
    ...bad.map(id => `${id} ${byId.get(id).status}: ${String(byId.get(id).evidence).split('\n')[0]}`),
  ]
  return { status: 'failed', evidence: `step 5 regression: ${missing.length + bad.length} of ${ids.length} did not pass (${lines.join('; ')})` }
}

/** H18: step 5's headless items over the step-5 headless ctx. */
async function step5Regression(ctx) {
  if (ctx?.regressionError !== undefined) return { status: 'failed', evidence: `step 5 headless scenarios failed: ${ctx.regressionError}` }
  if (ctx?.regression === undefined) return { status: 'failed', evidence: 'step 5 headless scenarios did not run' }
  const results = []
  for (const check of STEP5_HEADLESS) results.push([check.id, await evaluateItem(check, ctx.regression)])
  return regressionVerdict(results)
}

/** A step-6 headless phase's observations, or the failure that kept them out. */
const step6Phase = (name, judge) => async (ctx) => {
  if (ctx?.step6Error !== undefined) return { status: 'failed', evidence: `step 6 headless scenario failed: ${ctx.step6Error}` }
  const error = ctx?.step6?.errors?.[name]
  if (error !== undefined) return { status: 'failed', evidence: `step 6 ${name} phase failed: ${error}` }
  return judge(ctx?.step6?.[name], ctx)
}

/** A meta-improvement item over the step-6 meta scenario; a crashed phase fails every item. The rework observations ride along (H05, H06 read them). */
const metaItem = id => async (ctx) => {
  if (ctx?.step6MetaError !== undefined) return { status: 'failed', evidence: `step 6 meta scenario failed: ${ctx.step6MetaError}` }
  if (ctx?.step6Meta === undefined) return { status: 'failed', evidence: 'step 6 meta scenario did not run' }
  const crashed = Object.entries(ctx.step6Meta.errors ?? {})
  if (crashed.length > 0) return { status: 'failed', evidence: `step 6 meta ${crashed.map(([name, error]) => `${name} phase failed: ${String(error).split('\n')[0]}`).join('; ')}` }
  return META_JUDGES[id]({ ...ctx.step6Meta, rework: ctx.step6Rework })
}

/** The phase of the rework scenario each rework item reads. */
const REWORK_PHASE = { H19: 'shared', H20: 'literal', H21: 'similar', H22: 'similar', H23: 'literal', H24: 'metaLiteral' }

/** A rework item (H19–H24) over step6-rework.mjs; a crash of its phase fails it. H22 also reads step 5's H19 (user-task candidates). */
const reworkItem = id => async (ctx) => {
  if (ctx?.step6ReworkError !== undefined) return { status: 'failed', evidence: `step 6 rework scenario failed: ${ctx.step6ReworkError}` }
  if (ctx?.step6Rework === undefined) return { status: 'failed', evidence: 'step 6 rework scenario did not run' }
  const error = ctx.step6Rework.errors?.[REWORK_PHASE[id]]
  if (error !== undefined) return { status: 'failed', evidence: `step 6 rework ${REWORK_PHASE[id]} phase failed: ${String(error).split('\n')[0]}` }
  const userTasks = STEP5_HEADLESS.find(check => check.id === 'H19')
  const step5H19 = id === 'H22' && ctx.regression !== undefined ? await evaluateItem(userTasks, ctx.regression) : undefined
  return REWORK_JUDGES[id]({ ...ctx.step6Rework, step5H19 })
}

/** A step-6 desktop item over the improver scenario. */
const desktopItem = id => async (ctx) => {
  if (ctx?.step6DesktopError !== undefined) return { status: 'failed', evidence: `step 6 desktop scenario failed: ${ctx.step6DesktopError}` }
  return DESKTOP_JUDGES[id](ctx?.step6Desktop)
}

/** An experiment-layer observation, or the failure that kept it out. */
const experimentItem = (name, judge) => async (ctx) => {
  const error = ctx?.experimentErrors?.[name]
  if (error !== undefined) return { status: 'failed', evidence: `experiment ${name} failed: ${error}` }
  return judge(ctx?.[name])
}

/** E04: the experiment's report and the pilot's report (ADR 0011), both reproducible and traceable. */
const bothReports = async (ctx) => {
  const results = [await experimentItem('report', judgeReport)(ctx), await experimentItem('pilotReport', judgePilotReport)(ctx)]
  return { status: results.every(r => r.status === 'passed') ? 'passed' : 'failed', evidence: `experiment report: ${results[0].evidence} — pilot report: ${results[1].evidence}` }
}

const item = (id, layer, title, run) => (run === undefined ? { id, layer, title } : { id, layer, title, run })

/** D01–D23 from step 5 (D01–D18 are steps 2–4's), judged by their own judges. */
const desktopRegression = STEP5_CHECKS
  .filter(check => check.layer === 'desktop')
  .map(check => ({ id: check.id, layer: 'desktop', title: `（回归）${check.title.replace(/^（回归）/, '')}`, run: check.run }))

/** All checklist items, in plan order (D01–D23 before D24). Add a run to implement one. */
export const CHECKS = [
  item('H01', 'headless', 'v0：没有改进器记录的项目用 IMPROVER_V0，步骤 5 的作业行为不变（accept-step5 H01–H19 在 v0 下继续通过）', step6Phase('v0', async (obs, ctx) => judgeV0(obs, await step5Regression(ctx)))),
  item('H02', 'headless', '改进器版本：同内容同版本；采用历史是摘要链；回滚是新修订、不删文件；坏文件不加载并自动退回', step6Phase('store', judgeStore)),
  item('H03', 'headless', '固定版本：作业开始时固定改进器版本，作业中途采用新版本不影响它；job.json、改进会话与账本都写同一版本', step6Phase('pinned', judgePinned)),
  item('H04', 'headless', '元改进触发：第 K−1 个结束作业后不开始，第 K 个后开始；取消与中断的作业不计；开关关时不自动开始，显式触发照常', metaItem('H04')),
  item('H05', 'headless', '元诊断：只读，合 schema，证据指向真实的作业记录；不合 schema 3 次后 failed；none 时 no-proposal', metaItem('H05')),
  item('H06', 'headless', '元提案：恰好一个改动、合 schema、在上下限内；改评价器字段、超出上下限、多于一个改动被拒', metaItem('H06')),
  item('H07', 'headless', '同一起点：两臂的快照摘要、反馈集与纪元 id 相同；人为改动其中一份时不比较；起点按 ADR 0009 选取（先找未解决的作业，再退回反馈当时的能力版本）并写明种类，种类不同也不比较', metaItem('H07')),
  item('H08', 'headless', '隔离：父子比较全程在副本里，真实项目的文件、会话、能力、成果与采用历史不变', metaItem('H08')),
  item('H09', 'headless', '子必须真跑：子改进器在副本里跑完一次作业并产出后代才可能被采用；没产出后代时不采用', metaItem('H09')),
  item('H10', 'headless', '比较规则：decideImprover 的结论与按规则从两臂记录重新算出的一致；任何 unknown 不采用', metaItem('H10')),
  item('H11', 'headless', '采用后生效：新 OS 进程里下一个真实改进作业用子改进器版本，账本可证；“首次被使用”指向这个作业', metaItem('H11')),
  item('H12', 'headless', '拒绝：拒绝原因、改动、两臂结果保留，父改进器照常使用', metaItem('H12')),
  item('H13', 'headless', '纪元：评价器设置改动后纪元 id 变化；跨纪元不比较；改进器与元提案写不到评价器设置', metaItem('H13')),
  item('H14', 'headless', '预算与费用：元改进预算用尽即停，记 budget-exhausted；元改进费用带 metaJobId 与阶段，与普通作业、普通任务分开可查', metaItem('H14')),
  // H15, E03, R03–R07 rewritten per the user's decision of 2026-10-14 08:12 (“按推薦”, REWORK_EXPECTATIONS `rewritten`).
  item('H15', 'headless', '并发与恢复（ADR 0012 第 3 条）：同一用户同时只有一个元改进作业，第二个被拒；元改进进行时普通作业照常开始；元改进作业进程被强杀后下次启动标为中断，不重跑', metaItem('H15')),
  item('H16', 'headless', '副本保留：默认决定写完后删除比较副本；实验选项下保留并登记，超过上限时拒绝', metaItem('H16')),
  item('H17', 'headless', '账本完整：新记录与字段全部通过 schema；.nexgent/ 与导出物中搜不到测试密钥', metaItem('H17')),
  item('H18', 'headless', '回归：accept-step5 的 H01–H19（含步骤 3、4 回归）继续通过', step5Regression),
  // Step-6 rework (docs/plan/step-6-rework-partition.md R7; ADR 0012, 0013): skeleton in round 1, wired in round 3 over step6-rework.mjs.
  item('H19', 'headless', '改进器用户级共享（ADR 0012）：同一 NEXGENT_HOME 下两个项目读到同一个生效改进器，回滚影响两者；旧项目级 .nexgent/improvers/ 只读、不被读成生效版本；job.json 与账本记 improverScope "user"；项目关掉 shareImproverEvidence 后其作业不计入元改进、不被元诊断读取，但仍用共享改进器', reworkItem('H19')),
  item('H20', 'headless', '提案时具体数值被拒（ADR 0013 第 2 条）：改进作业里 capability_propose 的组件含反馈原文或反馈原题成果里的具体数值时被拒，返回命中的值与来源，去掉后可再提；在两个以上任务里出现的项目常量、列名不算', reworkItem('H20')),
  item('H21', 'headless', '同类题变差被拒（ADR 0013 第 1 条）：改进作业的候选修好反馈原题，但同类题上确定性检查通过率低于基线时不采用，原因 similar-regression；同类题上有 unknown 时按 unknown 记', reworkItem('H21')),
  item('H22', 'headless', '没有同类题等批准（ADR 0013 第 1 条）：选择集里除反馈原题外没有用例时不自动采用，改为 await-approval，原因 no-similar-cases；用户任务自己提出的候选结论不变', reworkItem('H22')),
  item('H23', 'headless', '门控前具体数值拒绝（ADR 0013 第 2、3 条）：候选含具体数值时门控不回放、直接拒绝，原因 instance-literal，账本里没有这次试验的回放请求；评价器规则 id 为 adr-0016（ADR 0014、0015、0016 先后取代 adr-0013），纪元 id 随之改变', reworkItem('H23')),
  item('H24', 'headless', '元改进改动夹带项目数值被拒（ADR 0012 第 5 条）：元提案改动的文字含本批任一项目反馈原文或成果里的具体数值时被退回，写明命中的值，不存子改进器', reworkItem('H24')),
  ...desktopRegression,
  item('D24', 'desktop', '“改进”页每个作业显示所用的改进器版本；元改进作业有单独的标记', desktopItem('D24')),
  item('D25', 'desktop', '元改进作业详情：元诊断摘要、改动前后对照、父子两臂的后代、门控结论、质量与费用、决定与原因', desktopItem('D25')),
  item('D26', 'desktop', '设置页“元改进”开关与元改进预算（用户级，ADR 0012）可改，重启后保持；关闭后不再自动开始元改进作业', desktopItem('D26')),
  item('D27', 'desktop', '改进器版本可在界面里回滚，回滚后下一个作业用回滚后的版本', desktopItem('D27')),
  item('E01', 'experiment', '两个任务族的生成器同一种子产出相同文件；四个集合不重叠', experimentItem('sets', judgeSets)),
  item('E02', 'experiment', '隔离（ADR 0011）：holdout 的用户消息、种子与素材在实验项目与试点各臂（base、memory、parent，各自的 NEXGENT_HOME）的会话、快照与回执里搜不到；门控挑中的用例都不在 holdout', experimentItem('rehearsal', judgeRehearsalIsolation)),
  item('E03', 'experiment', '试点三臂 holdout（ADR 0011）：base / memory / parent，每题每臂至少 3 次，每次新副本新会话、每臂独立 NEXGENT_HOME', experimentItem('rehearsal', judgeHoldoutArms)),
  item('E04', 'experiment', '报告生成器对同一份原始记录两次生成的报告相同；报告里每个数字都能追到原始记录（ADR 0011：试点报告多出的列也是）', bothReports),
  item('R01', 'real', '两个任务族各建一个实验项目，跑完 selection 与 guard 的历史任务，留下快照与检查；任务提示不提能力工具'),
  item('R02', 'real', '每个任务族的 dev 任务收到模拟用户反馈后，改进作业自动开始，用改进器 v0，产出诊断、候选与门控结论（结论如实记录）'),
  item('R03', 'real', '试点不跑元改进（ADR 0011 第 2 条）：每类任务的改进作业用改进器 v0、当前纪元（adr-0016），清单记录改进器版本与纪元，实验中没有元改进作业'),
  item('R04', 'real', 'memory 臂（ADR 0011，试点没有 child 臂）：编排经能力存储写入并采用一条上下文策略 project-notes（该类全部计数反馈原文），不诊断、不过门控；清单记录它的能力版本与全文摘要'),
  item('R05', 'real', 'holdout（ADR 0011）：两类试点任务各三臂（base、memory、parent）跑完全部 holdout 用例 × 3 次，每臂独立 NEXGENT_HOME；判定结果、组件调用证据与费用都有记录，没有 unknown 混进成功'),
  item('R06', 'real', '试点报告（ADR 0011）：三个比较（parent − base、memory − base、parent − memory）的配对差值、两层自助法 95% 区间与正 / 零 / 负，评分可靠三判据；费用（含改进作业）；失败与缺测单列；试点累计费用不超过 12 美元闸门'),
  item('R07', 'real', '（不进门槛）试点没有子改进器（ADR 0011）：被采用组件按“项目约定或事实 / 做事方法”分类，背答案率与追问次数按臂记录'),
  item('R08', 'real', '（可选，不进门槛）Windows 上一个任务族的 R01–R04'),
]

/** Items that do not count toward the exit criteria. */
export const OPTIONAL_CHECKS = new Set(['R07', 'R08'])

/** The items the step-6 rework adds (round 1: skeleton; round 3: wired over step6-rework.mjs). */
export const REWORK_ITEMS = ['H19', 'H20', 'H21', 'H22', 'H23', 'H24']

/**
 * What the step-6 rework (ADR 0011–0013, docs/plan/step-6-rework-partition.md) changes in
 * the checks that exist today, item by item, so round 3 knows what to rewire and the user
 * sees why. Round 3 rewired them (see each judge's evidence).
 *
 * `kind`:
 *  - `change`: the item stays, but its scenario or judge must follow the new rule;
 *  - `verify`: expected to hold unchanged; confirm when the new rules land;
 *  - `stale`: the item's own wording asserts something the new ADRs reverse. Listed for
 *    the user to decide; never deleted or loosened without that decision;
 *  - `rewritten`: a `stale` item the user decided on (`decided`), rewritten as the reason says.
 * `step`: 5 (accept-step5) or 6 (accept-step6).
 */
export const REWORK_EXPECTATIONS = [
  // accept-step6
  { step: 6, id: 'H01', kind: 'change', adr: '0012', why: '“项目里没有 .nexgent/improvers/” 改为“NEXGENT_HOME 下没有改进器记录时用 v0”；作业另记 improverScope "user"' },
  { step: 6, id: 'H02', kind: 'change', adr: '0012', why: '改进器版本线从项目 .nexgent/improvers/ 搬到 <NEXGENT_HOME>/improvers/，场景与判定读新位置；内容寻址、摘要链、回滚语义不变' },
  { step: 6, id: 'H03', kind: 'change', adr: '0012', why: '固定版本的规则不变；job.json、改进会话头与账本还要都写 improverScope "user"' },
  { step: 6, id: 'H04', kind: 'change', adr: '0012', why: '元改进按用户计数：两个项目合计 3 个结束作业即触发，计入项按 (projectId, jobId) 记在用户级队列；开关与 everyJobs 改在用户级配置，不再经项目 settings.update' },
  { step: 6, id: 'H05', kind: 'change', adr: '0012', why: '元诊断工具多一个 projectId 参数，只能读本批涉及的项目；要加“读本批以外的项目被拒”的反例' },
  { step: 6, id: 'H06', kind: 'change', adr: '0012', why: '提案被拒的情形多一种：改动文字含具体数值（新 H24 单独判，H06 证据里引用它）' },
  { step: 6, id: 'H07', kind: 'change', adr: '0012', why: '起点在本批涉及的所有项目里按 ADR 0009、0010 找，两臂在起点项目的副本里跑；判定的独立复算要跨项目' },
  { step: 6, id: 'H08', kind: 'change', adr: '0012', why: '隔离还要证明比较臂没有写用户级改进器（副本里不写 <NEXGENT_HOME>/improvers/）' },
  { step: 6, id: 'H09', kind: 'verify', adr: '0013', why: '子臂在副本里过门控时也按 adr-0013 判：副本的选择集要有同类题，子臂后代才可能“过门控”；现有场景的选择集有同类题（regions-2026-08），预计仍成立' },
  { step: 6, id: 'H10', kind: 'verify', adr: '0013', why: 'decideImprover 不变；arm 记录里多出同类题字段时复算仍按原规则' },
  { step: 6, id: 'H11', kind: 'change', adr: '0012', why: '“生效版本”读用户级 improvers.list（不带 projectId）；新进程要用同一个 NEXGENT_HOME' },
  { step: 6, id: 'H12', kind: 'change', adr: '0012', why: '查改进器历史改为用户级 API；拒绝时用户级版本线不变' },
  { step: 6, id: 'H13', kind: 'change', adr: '0013', why: '规则 id 从 adr-0008 改为 adr-0013（本轮中 ADR 0014、0015、0016 又先后改为 adr-0014、adr-0015、adr-0016），纪元 id 的值随之改变；“改评价器设置换纪元”的判定不变，另加“新旧纪元的试验不放进同一比较”' },
  { step: 6, id: 'H14', kind: 'change', adr: '0012', why: '元改进预算移到用户级配置，按用户计；场景改用户级配置降预算' },
  { step: 6, id: 'H15', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0012', why: '条目写“元改进作业与普通作业共用作业位”，现判定要求元改进进行时普通作业被拒（improvement/busy）。ADR 0012 第 3 条改为“整个用户只有一个元改进作业，它与各项目的能力作业互不占位”。建议改成：同一用户第二个元改进作业被拒；元改进进行时普通作业照常开始；强杀后中断、不重跑不变' },
  { step: 6, id: 'H16', kind: 'verify', adr: '0012', why: '副本保留与上限不变；副本仍在起点项目旁的临时目录' },
  { step: 6, id: 'H17', kind: 'change', adr: '0012', why: 'schema 检查范围加入用户级文件（<NEXGENT_HOME>/improvers/、用户级元改进队列与配置）与新字段 improverScope；搜密钥也要扫 NEXGENT_HOME' },
  { step: 6, id: 'H18', kind: 'verify', adr: '0013', why: '跟随 accept-step5 的变化（见下面 step 5 各条）' },
  { step: 6, id: 'D24', kind: 'change', adr: '0012', why: '每个作业除改进器版本外还要显示范围（用户级）' },
  { step: 6, id: 'D25', kind: 'change', adr: '0013', why: '元改进详情里的门控结论可能出现三个新原因，要显示中文说明（由 R5 定文字）' },
  { step: 6, id: 'D26', kind: 'change', adr: '0012', why: '“元改进”开关与预算移到用户级“改进器与元改进”设置，不写 .nexgent/config.json；项目级只剩“参与改进器学习”（shareImproverEvidence），判定要分开读两处' },
  { step: 6, id: 'D27', kind: 'change', adr: '0012', why: '回滚写 <NEXGENT_HOME>/improvers/activation；确认框列出最近用过该改进器的项目；回滚后另一个项目的下一个作业也用回滚后的版本' },
  { step: 6, id: 'E01', kind: 'verify', adr: '0011', why: '表格、代码两族保留为题库，生成器检查不变；试点的两类新任务另需同样的检查（第 3 轮补）' },
  { step: 6, id: 'E02', kind: 'change', adr: '0011', why: '隔离判定扫描的臂从 base/parent/child 改为试点的 base/memory/parent；每臂独立 NEXGENT_HOME 也要扫' },
  { step: 6, id: 'E03', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0011', why: '条目与判定要求 base、parent、child 三臂；ADR 0011 第 2 条规定试点跑 base、memory、parent，不跑元改进与 child。建议改成“试点三臂 base/memory/parent，每题每臂至少 3 次，每次新副本新会话、每臂独立 NEXGENT_HOME”' },
  { step: 6, id: 'E04', kind: 'change', adr: '0011', why: '报告可复现的判定不变；报告多出的列（组件分类、背答案率、追问次数、重复间波动、评分可靠三判据）也要能追到原始记录' },
  { step: 6, id: 'R03', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0011', why: '“每个任务族触发一次元改进作业”：试点不跑元改进' },
  { step: 6, id: 'R04', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0011', why: '“父子比较”：试点没有 child 臂' },
  { step: 6, id: 'R05', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0011', why: '“三臂（base、parent、child）各跑完全部 holdout”：试点是 base、memory、parent，两类新任务' },
  { step: 6, id: 'R06', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0011', why: '“两个差值”改为三个比较（parent − base、memory − base、parent − memory）加评分可靠三判据；费用闸门 12 美元' },
  { step: 6, id: 'R07', kind: 'rewritten', decided: '2026-10-14 08:12 按推薦', adr: '0011', why: '“子改进器被采用后再跑真实作业”：试点没有子改进器' },
  // accept-step5
  { step: 5, id: 'H07', kind: 'verify', adr: '0013', why: '提案时要过具体数值检查；脚本化技能 region-table-convention 不含三位以上整数、小数或日期，预计不被拦' },
  { step: 5, id: 'H09', kind: 'verify', adr: '0013', why: '选择集 = 反馈原题 regions-2026-09 + 同类题 regions-2026-08，有同类题，判定不变；回放集按两组记' },
  { step: 5, id: 'H10', kind: 'verify', adr: '0013', why: '反馈检查不变；门控结论多出同类题通过率，证据里要分开写' },
  { step: 5, id: 'H11', kind: 'verify', adr: '0013', why: '期望仍是“自动采用”：同类题 regions-2026-08 上候选确定性检查须不低于基线、无 unknown；脚本化回放两边都过，预计仍采用。若不成立，按 ADR 0013 改期望或补历史任务，并逐条报给用户' },
  { step: 5, id: 'H12', kind: 'verify', adr: '0013', why: '拒绝原因 unknown-runs 不变；ADR 0013 规定同类题有 unknown 时也按 unknown 记，结论相同' },
  { step: 5, id: 'H13', kind: 'verify', adr: '0013', why: '历史不足时等历史的规则不变；补足后的选择集含同类题，不会落到 no-similar-cases' },
  { step: 5, id: 'H15', kind: 'verify', adr: '0012', why: '“同一项目同时只有一个作业”仍成立（能力作业仍按项目占位）' },
  { step: 5, id: 'H18', kind: 'change', adr: '0012', why: 'job.json、账本多出 improverScope；schema 检查自然覆盖，但要确认判定里列出的文件种类' },
  { step: 5, id: 'H19', kind: 'verify', adr: '0013', why: '步骤 4 的候选来自用户任务，ADR 0013 第 1 条不适用；纪元规则 id 改变不影响步骤 4 判定' },
  { step: 5, id: 'D19', kind: 'verify', adr: '0013', why: '已采用作业的显示依赖步骤 5 H11 的自动采用；同类题 regions-2026-08 上不变差时预计仍显示“已采用”' },
  { step: 5, id: 'D20', kind: 'change', adr: '0013', why: '拒绝原因可能出现 similar-regression、no-similar-cases、instance-literal，桌面需中文说明（R5）；现有场景的原因不变' },
  { step: 5, id: 'D23', kind: 'verify', adr: '0013', why: '“已被后续任务使用”依赖步骤 5 H11 的自动采用；预计不变，采用期望若改则一并改' },
]

/**
 * Parse `--layer` (comma-separated) into known layer ids, in run order.
 * @returns `{ ok: true, layers }` or `{ ok: false, reason }`.
 */
export function parseLayers(value) {
  if (value === undefined || value === '') return { ok: true, layers: [...DEFAULT_LAYERS] }
  const wanted = value.split(',').map(part => part.trim()).filter(Boolean)
  const expanded = wanted.includes('all') ? Object.keys(LAYERS) : wanted
  const unknown = expanded.filter(layer => !(layer in LAYERS))
  if (unknown.length > 0) return { ok: false, reason: `unknown layer ${unknown.join(', ')} (known: ${Object.keys(LAYERS).join(', ')}, all)` }
  return { ok: true, layers: Object.keys(LAYERS).filter(layer => expanded.includes(layer)) }
}

/**
 * Which env var supplies the real-model key, without reading its value out.
 * @returns the variable name, or undefined when none is set.
 */
export function realModelKeySource(env) {
  return REAL_MODEL.keyEnv.find(name => typeof env[name] === 'string' && env[name].length > 0)
}
