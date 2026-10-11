/**
 * The step-3 acceptance checklist (docs/plan/step-3-work-partition.md
 * §`accept-step3` 检查项清单) as data, plus the pure pieces of the runner,
 * so they can be unit-tested (`packages/test-support/tests/accept-step3.spec.ts`).
 *
 * Same contract as step 2 (step2-checks.mjs): an entry with `run(ctx)` is
 * implemented; an entry without it is reported `not-implemented` — never a
 * pass — and the script exits 2. Item evaluation, the exit rule and the
 * budget gate are step 2's, re-exported unchanged.
 *
 * Headless items run the judge of the same id (step3-judges.mjs) over the
 * observations the headless layer collected (`ctx.obs`). D01–D10 are the
 * step-2 desktop items, run again as a regression with step 2's scenario and
 * judges; D11–D14 are step 3's own (step3-desktop.mjs, step3-desktop-judges.mjs), judged
 * from the members scenario's observations (`ctx.members`).
 */
import { CHECKS as STEP2_CHECKS } from './step2-checks.mjs'
import { judgeDesktop } from './step2-desktop-judges.mjs'
import { MEMBER_JUDGES, judgeMembers } from './step3-desktop-judges.mjs'
import { JUDGES, judge } from './step3-judges.mjs'

export { budgetGate, decideExit, evaluateItem, EXIT_FAIL, EXIT_NOT_READY, EXIT_PASS } from './step2-checks.mjs'

/** Layers in run order. `real` is only run when asked for explicitly. */
export const LAYERS = /** @type {const} */ ({
  headless: { title: '无界面层（脚本化 provider，经 SDK）', prefix: 'H' },
  desktop: { title: '桌面层（脚本化 provider，Playwright 驱动 Electron；D01–D10 为步骤 2 回归）', prefix: 'D' },
  real: { title: '真实模型层（手动）', prefix: 'R' },
})

/** Default layers when `--layer` is not given. */
export const DEFAULT_LAYERS = ['headless', 'desktop']

/** Real-model run facts (ADR 0003; user decisions 2026-10-11 15:20–15:24). */
export const REAL_MODEL = {
  model: 'claude-sonnet-5-5',
  thinking: 'on',
  budgetUsd: 15,
  /** Five runs (R01–R05) on Linux; the plan estimates 2–3 USD in total. */
  runs: 5,
  /** Estimated-cost cap of one run. */
  runCapUsd: 3,
  keyEnv: ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY'],
  task: 'scripts/real-task/step3-restock: inventory.xlsx → purchase.xlsx (Plan formulas, Summary); feedback "P01 现有库存应为 20" → v2; direct / delegate / team / workflow / unspecified',
}

const headlessRun = id => (ctx) => {
  if (ctx?.scenarioError !== undefined) return { status: 'failed', evidence: `headless scenario failed: ${ctx.scenarioError}` }
  return judge(id, ctx.obs, ctx.tools)
}
const desktopRegressionRun = id => (ctx) => {
  if (ctx?.scenarioError !== undefined) return { status: 'failed', evidence: `desktop scenario failed: ${ctx.scenarioError}` }
  return judgeDesktop(id, ctx.obs)
}
const membersRun = id => (ctx) => {
  if (ctx?.membersError !== undefined) return { status: 'failed', evidence: `desktop members scenario failed: ${ctx.membersError}` }
  return judgeMembers(id, ctx?.members)
}
const item = (id, layer, title) => {
  if (layer === 'headless' && JUDGES[id] !== undefined) return { id, layer, title, run: headlessRun(id) }
  if (layer === 'desktop' && MEMBER_JUDGES[id] !== undefined) return { id, layer, title, run: membersRun(id) }
  return { id, layer, title }
}

/** D01–D10 from step 2, judged by step 2's desktop judges. */
const desktopRegression = STEP2_CHECKS
  .filter(check => check.layer === 'desktop')
  .map(check => ({ id: check.id, layer: 'desktop', title: `（步骤 2 回归）${check.title}`, run: desktopRegressionRun(check.id) }))

/** All checklist items, in plan order (D01–D10 before D11). Add a judge to implement one. */
export const CHECKS = [
  item('H01', 'headless', '直接执行：一轮完成并 present，账本 executionForm: direct，无子会话'),
  item('H02', 'headless', '委派 fresh：子会话 parentSessionId 正确；子会话首轮请求含传入资料的引用、不含父历史'),
  item('H03', 'headless', '委派 fork：子会话请求含父会话上一轮为止的历史；强杀后恢复，fork 历史仍在'),
  item('H04', 'headless', '委派返回：子会话 present 的成果出现在父会话的工具结果与 subagent.end 中；父会话随后 present 的最终成果引用了子会话产出的文件'),
  item('H05', 'headless', '团队：两名队友并发工作，邮箱消息投递恰好一次，任务板依赖生效，各自 present'),
  item('H06', 'headless', '团队恢复：在消息 queued 与 delivered 之间强杀 Lead 进程，恢复后不丢不重，任务板与强杀前一致'),
  item('H07', 'headless', '工作流脚本：parallel 两个成员 + pipeline 一个汇总成员，并发数不超上限，汇总成员 present 最终成果'),
  item('H08', 'headless', '声明式图：一张三节点图编译执行；含环的图被拒并给出可读错误'),
  item('H09', 'headless', '工作流恢复：强杀后恢复，已完成成员不重跑，未完成成员标为 interrupted'),
  item('H10', 'headless', '归属：每个请求、工具调用、task.outcome 都有 taskId、memberId、executionForm，与实际形态一致'),
  item('H11', 'headless', '费用树：perTask 上限按整棵任务树计，子会话花费后父会话被拦截，记录为 budget/exhausted'),
  item('H12', 'headless', '沙箱继承：只读父会话下，子会话请求更宽模式被拒；预设的 deny 工具对成员不可见'),
  item('H13', 'headless', '取消传播：父会话取消，子会话、队友、工作流成员都以 parent 结束，无残留子孙进程'),
  item('H14', 'headless', '成员审批：子会话写 .env 时审批请求带成员名与子会话 id；拒绝后文件不变'),
  item('H15', 'headless', '成员不能再委派：成员的工具列表里没有 delegate、团队、工作流工具'),
  item('H16', 'headless', '同名成果：两个成员 present 同一路径时各成一份成果，不互相追加版本'),
  item('H17', 'headless', 'PTC：run_code 读写工作区文件成功；读环境变量为空；读沙箱外文件被拒；超时终止且无残留进程'),
  item('H18', 'headless', '表格：write_spreadsheet 写出的公式与缓存值正确；外部引用、未知函数、除零、超上限各被拒'),
  item('H19', 'headless', '网页：本地测试服务器上的页面经 web_fetch 转成 Markdown；私网、回环、重定向到私网被拒'),
  item('H20', 'headless', '技能：用户级技能被发现；同名时项目级优先'),
  item('H21', 'headless', '恢复后经 SDK 查询：父会话、子会话列表、成员成果、团队状态、工作流状态全部可见'),
  item('H22', 'headless', '会话 seq 连续、全部记录通过 schema（含新记录类型）；.nexgent/ 与 export 产物中搜不到测试密钥'),
  item('H23', 'headless', '仓库里没有 Python 文件，没有 nexgent/、stage-*、tests/、config.py、runtime/'),
  ...desktopRegression,
  item('D11', 'desktop', '委派时中栏出现成员块（名称、状态），结束后显示成果链接'),
  item('D12', 'desktop', '点开成员块进入子会话只读视图，可返回'),
  item('D13', 'desktop', '成员发起的审批对话框显示成员名，选择后继续'),
  item('D14', 'desktop', '强杀主进程后重启，成员块、子会话与成员成果仍在'),
  item('R01', 'real', 'Excel 补货任务直接执行：隐藏判定通过（Plan 公式、补货量、金额、Summary 合计；反馈改库存后新版本数值正确）'),
  item('R02', 'real', '同一任务用户要求委派：至少一个子会话，有子会话 present 的文件，最终成果通过判定'),
  item('R03', 'real', '同一任务用户要求团队：至少两名队友、至少一条邮箱消息，最终成果通过判定'),
  item('R04', 'real', '同一任务用户要求工作流：工作流记录与至少两个成员，最终成果通过判定'),
  item('R05', 'real', '不指定形态：记录模型选择的形态与理由，任务通过判定（选择本身不进门槛）'),
  item('R06', 'real', '同等预算对照：R02–R04 每种形态的费用、请求数、成功与否与 R01 并列写入摘要；不据此宣称协作有收益'),
  item('R07', 'real', '每次运行的请求数、token、unknown 数、估算费用写进摘要；累计费用不超过上限'),
  item('R08', 'real', '（可选，不进门槛）Windows 上 R01–R04'),
]

/** Items that do not count toward the exit criteria. */
export const OPTIONAL_CHECKS = new Set(['R08'])

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
