/**
 * The step-4 acceptance checklist (docs/plan/step-4-work-partition.md
 * §`accept-step4` 检查项清单) as data, plus the pure pieces of the runner,
 * so they can be unit-tested (`packages/test-support/tests/accept-step4.spec.ts`).
 *
 * Same contract as steps 2 and 3: an entry with `run(ctx)` is implemented;
 * an entry without it is reported `not-implemented` — never a pass — and the
 * script exits 2. Item evaluation, the exit rule and the budget gate are
 * step 2's, re-exported unchanged.
 *
 * H19 runs step 3's H01–H23 judges over a fresh run of step 3's headless
 * scenario (`ctx.step3`); D01–D14 are step 3's desktop items with their own
 * scenarios and judges. H01–H18 are judged (step4-judges.mjs) from the
 * step-4 headless scenario (`ctx.step4`): H01–H05, H07, H10, H17 since round
 * 2, H13, H14 and H18 since round 3; each reports not-implemented until the
 * product part it needs has landed, and the gate items (H06, H08, H09, H11,
 * H12, H15, H16, H14's adoption half) say the gate (W3) is missing.
 * D15–D18 are judged (step4-desktop-judges.mjs) from the capabilities
 * desktop scenario (`ctx.capabilities`, step4-desktop.mjs); R01–R07 wait for
 * round 4.
 */
import { CHECKS as STEP3_CHECKS } from './step3-checks.mjs'
import { JUDGES as STEP3_JUDGES, judge as judgeStep3 } from './step3-judges.mjs'
import { CAPABILITY_JUDGES, judgeCapabilities } from './step4-desktop-judges.mjs'
import { JUDGES, judge } from './step4-judges.mjs'

export { budgetGate, decideExit, evaluateItem, EXIT_FAIL, EXIT_NOT_READY, EXIT_PASS } from './step2-checks.mjs'

/** Layers in run order. `real` is only run when asked for explicitly. */
export const LAYERS = /** @type {const} */ ({
  headless: { title: '无界面层（脚本化 provider，经 SDK）', prefix: 'H' },
  desktop: { title: '桌面层（脚本化 provider，Playwright 驱动 Electron；D01–D14 为步骤 2、3 回归，D15–D18 能力版本）', prefix: 'D' },
  real: { title: '真实模型层（手动）', prefix: 'R' },
})

/** Default layers when `--layer` is not given. */
export const DEFAULT_LAYERS = ['headless', 'desktop']

/** Real-model run facts (partition §真实模型验收; user decisions 2026-10-12). */
export const REAL_MODEL = {
  model: 'claude-sonnet-5-5',
  thinking: 'on',
  budgetUsd: 15,
  keyEnv: ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY'],
  task: 'scripts/real-task/step4-orders: monthly order summaries; history tasks, task A builds a reusable function or skill, gate, task B in a new process, injected regression',
}

/**
 * H19's verdict from step 3's per-item results: passed only when every one of
 * H01–H23 passed; otherwise failed, naming each item that did not pass.
 * @param results - `[id, { status, evidence }]` pairs.
 */
export function regressionVerdict(results) {
  const ids = Object.keys(STEP3_JUDGES)
  const byId = new Map(results)
  const missing = ids.filter(id => !byId.has(id))
  const bad = ids.filter(id => byId.has(id) && byId.get(id).status !== 'passed')
  if (missing.length === 0 && bad.length === 0) return { status: 'passed', evidence: `step 3 ${ids[0]}–${ids.at(-1)}: all ${ids.length} passed` }
  const lines = [
    ...missing.map(id => `${id} not judged`),
    ...bad.map(id => `${id} ${byId.get(id).status}: ${String(byId.get(id).evidence).split('\n')[0]}`),
  ]
  return { status: 'failed', evidence: `step 3 regression: ${missing.length + bad.length} of ${ids.length} did not pass (${lines.join('; ')})` }
}

/** H19: step 3's headless judges over a fresh run of step 3's headless scenario. */
function step3Regression(ctx) {
  if (ctx?.step3Error !== undefined) return { status: 'failed', evidence: `step 3 headless scenario failed: ${ctx.step3Error}` }
  if (ctx?.step3 === undefined) return { status: 'failed', evidence: 'step 3 headless scenario did not run' }
  return regressionVerdict(Object.keys(STEP3_JUDGES).map(id => [id, judgeStep3(id, ctx.step3, ctx.tools)]))
}

/** A round-2 headless item: its judge over the step-4 scenario's observations. */
const step4Run = id => (ctx) => {
  if (ctx?.step4Error !== undefined) return { status: 'failed', evidence: `step 4 headless scenario failed: ${ctx.step4Error}` }
  if (ctx?.step4 === undefined) return { status: 'failed', evidence: 'step 4 headless scenario did not run' }
  return judge(id, ctx.step4)
}

/** A D15–D18 item: its judge over the capabilities desktop scenario's observations. */
const capabilitiesRun = id => (ctx) => {
  if (ctx?.capabilitiesError !== undefined) return { status: 'failed', evidence: `capabilities desktop scenario failed: ${ctx.capabilitiesError}` }
  if (ctx?.capabilities === undefined) return { status: 'failed', evidence: 'capabilities desktop scenario did not run' }
  return judgeCapabilities(id, ctx.capabilities)
}

const item = (id, layer, title, run) => {
  const wired = run
    ?? (layer === 'headless' && JUDGES[id] !== undefined ? step4Run(id) : undefined)
    ?? (layer === 'desktop' && CAPABILITY_JUDGES[id] !== undefined ? capabilitiesRun(id) : undefined)
  return wired === undefined ? { id, layer, title } : { id, layer, title, run: wired }
}

/** D01–D14 from step 3 (D01–D10 are step 2's), judged by their own judges; the desktop ctx has step 3's shape. */
const desktopRegression = STEP3_CHECKS
  .filter(check => check.layer === 'desktop')
  .map(check => ({ id: check.id, layer: 'desktop', title: `（回归）${check.title.replace(/^（步骤 2 回归）/, '')}`, run: check.run }))

/** All checklist items, in plan order (D01–D14 before D15). Add a run to implement one. */
export const CHECKS = [
  item('H01', 'headless', '基线：没有采用任何能力包时，任务正常完成，账本 capabilityVersion 为 baseline'),
  item('H02', 'headless', '草稿与试用：任务 A 写技能与函数模块，capability_try 后在本会话可用；草稿目录对模型的文件工具读写都拒绝'),
  item('H03', 'headless', '会话隔离：并行的另一会话看不到 A 的试用组件'),
  item('H04', 'headless', '候选提交：成功调用过的组件提交成功；从未成功调用的组件提交被拒'),
  item('H05', 'headless', '内容寻址：能力包目录写成后不可改；版本号与清单哈希一致'),
  item('H06', 'headless', '门控通过：好候选在回放集上两侧各跑 r 次，判定通过，采用历史追加 adopt 修订，决定记录含两侧检查、审核模型意见（单独标记）与费用'),
  item('H07', 'headless', '跨进程使用：新 OS 进程中的任务 B 自动加载新版本并调用组件；B 的全部账本记录带新版本，componentsUsed 列出组件，会话里有对应调用'),
  item('H08', 'headless', '门控拒绝：坏候选被拒，候选、回执与拒绝原因保留，采用版本不变，之后的任务照常用原版本'),
  item('H09', 'headless', '退化回滚（使用）：改坏已采用的函数模块，K 个任务内自动写 rollback 修订，之后的任务用回上一版本'),
  item('H10', 'headless', '退化回滚（加载）：篡改能力包文件，加载被拒并退回上一版本，有记录'),
  item('H11', 'headless', '隔离运行：试验期间真实项目的文件、会话与成果不变；试验请求带 trialId 与 arm'),
  item('H12', 'headless', '试验额度：额度用尽即停，结论为 unknown，不采用'),
  item('H13', 'headless', '候选改不到门控：上下文策略组件里出现审批、费用、沙箱或门控字段时 schema 拒绝'),
  item('H14', 'headless', '插件包：试用与采用各需一次审批；拒绝时不加载、不执行任何代码；门控通过后停在等待审批'),
  item('H15', 'headless', '回放集划分：selection 与 guard 不重叠；历史不足时门控等待而不是开始'),
  item('H16', 'headless', '恢复：试验进程被强杀后，下次启动标为中断，不重复采用，原版本可用'),
  item('H17', 'headless', '成员不能开发组件：成员的工具列表里没有三个能力工具'),
  item('H18', 'headless', '账本完整：task.outcome 带检查、componentsUsed、memberCosts；全部记录通过 schema；.nexgent/ 与导出物中搜不到测试密钥'),
  item('H19', 'headless', '回归：步骤 3 的 H01–H23 继续通过', step3Regression),
  ...desktopRegression,
  item('D15', 'desktop', '右栏显示当前能力版本；采用发生后新开对话显示新版本'),
  item('D16', 'desktop', '候选状态（试验中、采用、拒绝、回滚）可见，拒绝原因可点开'),
  item('D17', 'desktop', '插件包审批对话框显示包名与哈希，拒绝后状态为未采用'),
  item('D18', 'desktop', '手动回滚后版本显示与采用历史一致；重启后仍一致'),
  item('R01', 'real', '历史任务：同一项目先跑 2 个表格 / 数据任务，留下快照与检查（回放集的 guard 部分）'),
  item('R02', 'real', '任务 A：模型开发并使用一个函数模块或技能，提交为候选，任务本身通过隐藏判定'),
  item('R03', 'real', '门控：候选与基线在回放集上各跑 r 次，记录判定、审核意见与费用；结论如实记录'),
  item('R04', 'real', '任务 B（新进程）：门控通过时，B 自动加载并实际调用组件，账本可证，任务通过隐藏判定'),
  item('R05', 'real', '退化注入：改坏采用的组件，后续任务触发自动回滚，回滚后任务用原版本完成'),
  item('R06', 'real', '每次运行的请求数、token、unknown 数、估算费用写进摘要，试验费用单列；累计不超过上限'),
  item('R07', 'real', '（可选，不进门槛）Windows 上 R02–R04'),
]

/** Items that do not count toward the exit criteria. */
export const OPTIONAL_CHECKS = new Set(['R07'])

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
