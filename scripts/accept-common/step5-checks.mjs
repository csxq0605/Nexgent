/**
 * The step-5 acceptance checklist (docs/plan/step-5-work-partition.md
 * §`accept-step5` 检查项清单) as data, plus the pure pieces of the runner,
 * so they can be unit-tested (`packages/test-support/tests/accept-step5.spec.ts`).
 *
 * Same contract as steps 2–4: an entry with `run(ctx)` is implemented; an
 * entry without it is reported `not-implemented` — never a pass — and the
 * script exits 2. Item evaluation, the exit rule and the budget gate are
 * step 2's, re-exported unchanged.
 *
 * H19 runs step 4's own headless items H01–H19 (H19 there is step 3's
 * H01–H23) over fresh runs of their scenarios (`ctx.regression`, the step-4
 * headless ctx); D01–D18 are step 4's desktop items with their own scenarios
 * and judges (the desktop ctx has step 4's shape). The new headless items H01–H18
 * are judged (step5-judges.mjs) over the step-5 headless scenario (`ctx.step5`,
 * step5-headless.mjs), which runs `@nexgent/sdk` as shipped, evolve included;
 * D19–D23 are judged (step5-desktop-judges.mjs) over the improvements page
 * scenario (`ctx.improvements`, step5-desktop.mjs). R01–R07 are judged
 * (step5-real-judges.mjs) over the real scenario (`ctx.obs`, step5-real.mjs); R08
 * (Windows) has no run here: it is a manual run of the same layer on Windows.
 */
import { CHECKS as STEP4_CHECKS, evaluateItem } from './step4-checks.mjs'
import { judgeDesktop } from './step5-desktop-judges.mjs'
import { JUDGES, judge } from './step5-judges.mjs'
import { judgeReal } from './step5-real-judges.mjs'

export { budgetGate, decideExit, evaluateItem, EXIT_FAIL, EXIT_NOT_READY, EXIT_PASS } from './step2-checks.mjs'

/** Layers in run order. `real` is only run when asked for explicitly. */
export const LAYERS = /** @type {const} */ ({
  headless: { title: '无界面层（脚本化 provider，经 SDK）', prefix: 'H' },
  desktop: { title: '桌面层（脚本化 provider，Playwright 驱动 Electron；D01–D18 为步骤 2–4 回归，D19–D23 改进页）', prefix: 'D' },
  real: { title: '真实模型层（手动）', prefix: 'R' },
})

/** Default layers when `--layer` is not given. */
export const DEFAULT_LAYERS = ['headless', 'desktop']

/** Real-model run facts (partition §真实模型验收; user decisions 2026-10-13, item 10). */
export const REAL_MODEL = {
  model: 'claude-sonnet-5-5',
  thinking: 'on',
  budgetUsd: 15,
  keyEnv: ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY'],
  task: 'scripts/real-task/step5-orders: monthly region tables; history tasks, a feedback task with three counted feedbacks naming a missing column, an automatic improvement job, the gate, the next task in a new process',
}

/** Step 4's headless items, in order: what H19 re-runs. */
export const STEP4_HEADLESS = STEP4_CHECKS.filter(check => check.layer === 'headless')

/**
 * H19's verdict from step 4's per-item results: passed only when every one of
 * step 4's H01–H19 passed; otherwise failed, naming each item that did not pass.
 * @param results - `[id, { status, evidence }]` pairs.
 */
export function regressionVerdict(results) {
  const ids = STEP4_HEADLESS.map(check => check.id)
  const byId = new Map(results)
  const missing = ids.filter(id => !byId.has(id))
  const bad = ids.filter(id => byId.has(id) && byId.get(id).status !== 'passed')
  if (missing.length === 0 && bad.length === 0) return { status: 'passed', evidence: `step 4 ${ids[0]}–${ids.at(-1)}: all ${ids.length} passed (H19 there: step 3 H01–H23)` }
  const lines = [
    ...missing.map(id => `${id} not judged`),
    ...bad.map(id => `${id} ${byId.get(id).status}: ${String(byId.get(id).evidence).split('\n')[0]}`),
  ]
  return { status: 'failed', evidence: `step 4 regression: ${missing.length + bad.length} of ${ids.length} did not pass (${lines.join('; ')})` }
}

/** H19: step 4's headless items over the step-4 headless ctx. */
async function step4Regression(ctx) {
  if (ctx?.regressionError !== undefined) return { status: 'failed', evidence: `step 4 headless scenarios failed: ${ctx.regressionError}` }
  if (ctx?.regression === undefined) return { status: 'failed', evidence: 'step 4 headless scenarios did not run' }
  const results = []
  for (const check of STEP4_HEADLESS) results.push([check.id, await evaluateItem(check, ctx.regression)])
  return regressionVerdict(results)
}

/** A step-5 headless item with a judge: over the step-5 scenario's observations. */
const step5Run = id => (ctx) => {
  if (ctx?.step5Error !== undefined) return { status: 'failed', evidence: `step 5 headless scenario failed: ${ctx.step5Error}` }
  if (ctx?.step5 === undefined) return { status: 'failed', evidence: 'step 5 headless scenario did not run' }
  return judge(id, ctx.step5)
}

/** A real-model item: over the step-5 real scenario's observations. */
const realRun = id => (ctx) => {
  if (ctx?.scenarioError !== undefined) return { status: 'failed', evidence: `real scenario failed: ${ctx.scenarioError}` }
  if (ctx?.obs === undefined) return { status: 'failed', evidence: 'the real scenario did not run' }
  return judgeReal(id, ctx.obs)
}

const item = (id, layer, title, run) => {
  const wired = run ?? (layer === 'headless' && JUDGES[id] !== undefined ? step5Run(id) : undefined)
  return wired === undefined ? { id, layer, title } : { id, layer, title, run: wired }
}

/** D01–D18 from step 4 (D01–D14 are steps 2 and 3's), judged by their own judges. */
const desktopRegression = STEP4_CHECKS
  .filter(check => check.layer === 'desktop')
  .map(check => ({ id: check.id, layer: 'desktop', title: `（回归）${check.title.replace(/^（回归）/, '')}`, run: check.run }))

/** All checklist items, in plan order (D01–D18 before D19). Add a run to implement one. */
export const CHECKS = [
  item('H01', 'headless', '计数触发：2 条计入的反馈不开始作业，第 3 条开始；不计入的反馈（按拍板 2）不加计数'),
  item('H02', 'headless', '显式触发：“改进”动作在计数为 0 时立即开始作业；autoImprove 关时也能显式触发'),
  item('H03', 'headless', '检查失败触发：根任务检查失败计一次'),
  item('H04', 'headless', '开关：autoImprove 关时反馈照常记录，不开始作业'),
  item('H05', 'headless', '诊断：改进会话交出合 schema 的诊断（MAST 标签、证据引用指向真实记录、memberCosts 与账本一致）；不合 schema 3 次后 failed'),
  item('H06', 'headless', '改进会话只读：写文件、执行命令类工具不在工具列表里；不出现在对话列表里'),
  item('H07', 'headless', '提案：恰好一个组件、合 schema；碰受保护字段、多于一个组件被拒；proposalKind: none 时 no-proposal'),
  item('H08', 'headless', '提案隔离：提案阶段在快照副本里运行，真实项目的文件、会话与成果不变'),
  item('H09', 'headless', '门控回放集：selection 含反馈任务，guard 是其他历史任务，不重叠；回放里没有反馈轮的文字'),
  item('H10', 'headless', '反馈检查：两侧各有一条反馈检查，证据里与确定性检查分开标记；unknown 时不采用'),
  item('H11', 'headless', '采用与使用：新 OS 进程中的下一次任务自动加载新版本并调用组件，账本可证；作业记录“首次被使用”指向这个任务'),
  item('H12', 'headless', '拒绝：拒绝原因、候选、回执保留，原版本照常可用'),
  item('H13', 'headless', '历史不足：作业停在 waiting-history；补足历史后继续，不降门槛'),
  item('H14', 'headless', '预算：改进预算用尽即停，记 budget-exhausted；改进费用带 improvementId 与阶段，与正常任务分开可查'),
  item('H15', 'headless', '并发与恢复：同一项目同时只有一个作业；两进程同时提交反馈不重计；作业进程被强杀后下次启动标为中断，不重跑'),
  item('H16', 'headless', '每轮记录：反馈轮的检查与快照不覆盖原轮'),
  item('H17', 'headless', '不改配置：整个流程中 .nexgent/config.json 只在经 SDK 改设置时变化；改进作业与候选改不到开关、预算与门控字段'),
  item('H18', 'headless', '账本完整：新记录与字段全部通过 schema；.nexgent/ 与导出物中搜不到测试密钥'),
  item('H19', 'headless', '回归：accept-step4 的 H01–H19（含步骤 3 回归）继续通过', step4Regression),
  ...desktopRegression,
  item('D19', 'desktop', '“改进”页列出作业：触发原因、状态、候选改了什么、门控结果、费用、是否采用', ctx => judgeDesktop('D19', ctx)),
  item('D20', 'desktop', '拒绝、失败、no-proposal 的原因可点开；反馈检查与评审意见单独标记', ctx => judgeDesktop('D20', ctx)),
  item('D21', 'desktop', '成果卡片上点“改进”开始作业，进度在“改进”页可见', ctx => judgeDesktop('D21', ctx)),
  item('D22', 'desktop', '设置页“自动改进”开关与改进预算可改，重启后保持；关闭后反馈不再自动开始作业', ctx => judgeDesktop('D22', ctx)),
  item('D23', 'desktop', '采用后的下一次任务完成时，“改进”页显示“已被后续任务使用”及时间', ctx => judgeDesktop('D23', ctx)),
  item('R01', 'real', '历史任务：同一项目先跑 2–3 个表格 / 数据任务，留下快照与检查（回放集的补足与 guard 部分）；任务提示不提能力工具', realRun('R01')),
  item('R02', 'real', '反馈任务：一个表格任务完成后，用户给 3 条计入的反馈，指出隐藏判定能查到的问题；反馈也不提能力工具', realRun('R02')),
  item('R03', 'real', '自动作业：第 3 条反馈后作业自动开始，诊断合 schema，提案产出一个候选；全程没有人点名能力工具，记录模型选了哪种组件', realRun('R03')),
  item('R04', 'real', '门控：结论如实记录（采用、拒绝或等待都写进摘要），反馈检查与确定性检查分开列出', realRun('R04')),
  item('R05', 'real', '下一次任务（新进程，新数据，同类任务，不提示组件存在）：采用时自动加载并调用组件，账本可证，且隐藏判定确认反馈指出的问题这次没有出现', realRun('R05')),
  item('R06', 'real', '每个任务与作业各阶段的请求数、token、unknown 数、估算费用写进摘要，改进费用单列；累计不超过上限', realRun('R06')),
  item('R07', 'real', '（不进门槛）第二个作业：换一种反馈再走一遍，结论写进摘要，和主链一起给出“作业数 / 采用数”', realRun('R07')),
  item('R08', 'real', '（可选，不进门槛）Windows 上 R02–R05'),
]

/** Items that do not count toward the exit criteria. */
export const OPTIONAL_CHECKS = new Set(['R07', 'R08'])

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
