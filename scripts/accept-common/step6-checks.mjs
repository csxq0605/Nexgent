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
 * Round 1 (skeleton): only the regressions are wired. H18 runs step 5's own
 * headless items H01–H19 (H19 there is step 4's, which re-runs step 3's) over
 * fresh runs of their scenarios (`ctx.regression`, the step-5 headless ctx);
 * D01–D23 are step 5's desktop items with their own scenarios and judges (the
 * desktop ctx has step 5's shape). Everything new — H01–H17 (improver versions,
 * meta-improvement jobs, the parent / child comparison, epochs), D24–D27, the
 * experiment layer E01–E04 and the real layer R01–R08 — waits on W0–W6 and
 * reports not-implemented.
 */
import { CHECKS as STEP5_CHECKS, evaluateItem } from './step5-checks.mjs'

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
  task: 'scripts/experiment/step6: two task families (tables / data, multi-file code); dev / selection / guard / holdout; improver v0, one meta-improvement job per family, parent / child comparison, three holdout arms × 3 repeats',
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

const item = (id, layer, title, run) => (run === undefined ? { id, layer, title } : { id, layer, title, run })

/** D01–D23 from step 5 (D01–D18 are steps 2–4's), judged by their own judges. */
const desktopRegression = STEP5_CHECKS
  .filter(check => check.layer === 'desktop')
  .map(check => ({ id: check.id, layer: 'desktop', title: `（回归）${check.title.replace(/^（回归）/, '')}`, run: check.run }))

/** All checklist items, in plan order (D01–D23 before D24). Add a run to implement one. */
export const CHECKS = [
  item('H01', 'headless', 'v0：没有改进器记录的项目用 IMPROVER_V0，步骤 5 的作业行为不变（accept-step5 H01–H19 在 v0 下继续通过）'),
  item('H02', 'headless', '改进器版本：同内容同版本；采用历史是摘要链；回滚是新修订、不删文件；坏文件不加载并自动退回'),
  item('H03', 'headless', '固定版本：作业开始时固定改进器版本，作业中途采用新版本不影响它；job.json、改进会话与账本都写同一版本'),
  item('H04', 'headless', '元改进触发：第 K−1 个结束作业后不开始，第 K 个后开始；取消与中断的作业不计；开关关时不自动开始，显式触发照常'),
  item('H05', 'headless', '元诊断：只读，合 schema，证据指向真实的作业记录；不合 schema 3 次后 failed；none 时 no-proposal'),
  item('H06', 'headless', '元提案：恰好一个改动、合 schema、在上下限内；改评价器字段、超出上下限、多于一个改动被拒'),
  item('H07', 'headless', '同一起点：两臂的快照摘要、反馈集与纪元 id 相同；人为改动其中一份时不比较'),
  item('H08', 'headless', '隔离：父子比较全程在副本里，真实项目的文件、会话、能力、成果与采用历史不变'),
  item('H09', 'headless', '子必须真跑：子改进器在副本里跑完一次作业并产出后代才可能被采用；没产出后代时不采用'),
  item('H10', 'headless', '比较规则：decideImprover 的结论与按规则从两臂记录重新算出的一致；任何 unknown 不采用'),
  item('H11', 'headless', '采用后生效：新 OS 进程里下一个真实改进作业用子改进器版本，账本可证；“首次被使用”指向这个作业'),
  item('H12', 'headless', '拒绝：拒绝原因、改动、两臂结果保留，父改进器照常使用'),
  item('H13', 'headless', '纪元：评价器设置改动后纪元 id 变化；跨纪元不比较；改进器与元提案写不到评价器设置'),
  item('H14', 'headless', '预算与费用：元改进预算用尽即停，记 budget-exhausted；元改进费用带 metaJobId 与阶段，与普通作业、普通任务分开可查'),
  item('H15', 'headless', '并发与恢复：元改进作业与普通作业共用作业位；元改进作业进程被强杀后下次启动标为中断，不重跑'),
  item('H16', 'headless', '副本保留：默认决定写完后删除比较副本；实验选项下保留并登记，超过上限时拒绝'),
  item('H17', 'headless', '账本完整：新记录与字段全部通过 schema；.nexgent/ 与导出物中搜不到测试密钥'),
  item('H18', 'headless', '回归：accept-step5 的 H01–H19（含步骤 3、4 回归）继续通过', step5Regression),
  ...desktopRegression,
  item('D24', 'desktop', '“改进”页每个作业显示所用的改进器版本；元改进作业有单独的标记'),
  item('D25', 'desktop', '元改进作业详情：元诊断摘要、改动前后对照、父子两臂的后代、门控结论、质量与费用、决定与原因'),
  item('D26', 'desktop', '设置页“元改进”开关与元改进预算可改，重启后保持；关闭后不再自动开始元改进作业'),
  item('D27', 'desktop', '改进器版本可在界面里回滚，回滚后下一个作业用回滚后的版本'),
  item('E01', 'experiment', '两个任务族的生成器同一种子产出相同文件；四个集合不重叠'),
  item('E02', 'experiment', '隔离：holdout 的用户消息、种子与素材在实验项目的会话、快照与回执里搜不到；门控挑中的用例都不在 holdout'),
  item('E03', 'experiment', '三臂 holdout：每个用例每臂至少 3 次，每次新副本新会话'),
  item('E04', 'experiment', '报告生成器对同一份原始记录两次生成的报告相同；报告里每个数字都能追到原始记录'),
  item('R01', 'real', '两个任务族各建一个实验项目，跑完 selection 与 guard 的历史任务，留下快照与检查；任务提示不提能力工具'),
  item('R02', 'real', '每个任务族的 dev 任务收到模拟用户反馈后，改进作业自动开始，用改进器 v0，产出诊断、候选与门控结论（结论如实记录）'),
  item('R03', 'real', '每个任务族触发一次元改进作业：元诊断合 schema，元提案是一个合规改动（或 none，如实记录）'),
  item('R04', 'real', '父子比较：两臂起点一致，各在副本里跑完一次作业，decideImprover 结论如实记录'),
  item('R05', 'real', 'holdout：每个任务族三臂（base、parent、child）各跑完全部 holdout 用例 × 3 次，隐藏判定结果、组件调用证据与费用都有记录，没有 unknown 混进成功'),
  item('R06', 'real', '报告：按“报告口径”给出两个差值、区间、正 / 零 / 负、费用（含改进与元改进）与摊薄；失败与缺测单列；累计费用不超过上限'),
  item('R07', 'real', '（不进门槛）若子改进器在某个任务族被采用，在真实项目里再跑一个真实改进作业，证明它用的是子版本'),
  item('R08', 'real', '（可选，不进门槛）Windows 上一个任务族的 R01–R04'),
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
