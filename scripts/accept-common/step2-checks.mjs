/**
 * The step-2 acceptance checklist (docs/plan/step-2-work-partition.md
 * §`accept-step2` 检查项清单) as data, plus the pure pieces of the runner
 * (layer selection, item evaluation, exit code, real-model budget gate), so
 * they can be unit-tested (`packages/test-support/tests/accept-step2.spec.ts`).
 *
 * A check is implemented when its entry has a `run(ctx)` function returning
 * `{ pass: boolean, evidence: string }` or `{ status, evidence }` (status
 * `passed` / `failed` / `not-implemented`, for an item that is only partly
 * checkable yet). Entries without `run` are reported as `not-implemented`:
 * never a pass, and the script exits 2.
 *
 * Headless items run the judge of the same id (step2-judges.mjs) over the
 * observations the headless layer collected (`ctx.obs`, `ctx.tools`).
 */
import { JUDGES, judge } from './step2-judges.mjs'

export const EXIT_PASS = 0
export const EXIT_FAIL = 1
export const EXIT_NOT_READY = 2

/** Layers in run order. `real` is only run when asked for explicitly. */
export const LAYERS = /** @type {const} */ ({
  headless: { title: '无界面层（脚本化 provider，经 SDK 与 CLI）', prefix: 'H' },
  desktop: { title: '桌面层（脚本化 provider，Playwright 驱动 Electron）', prefix: 'D' },
  real: { title: '真实模型层（手动）', prefix: 'R' },
})

/** Default layers when `--layer` is not given. */
export const DEFAULT_LAYERS = ['headless', 'desktop']

/** Real-model run facts (ADR 0002, ADR 0003, user decisions 2026-10-11). */
export const REAL_MODEL = {
  model: 'claude-sonnet-5-5',
  thinking: 'on',
  budgetUsd: 15,
  keyEnv: ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY'],
  task: 'scripts/real-task/step2-sales: orders.csv + regions.xlsx; generate → feedback revision → kill mid-stream and resume',
}

const headlessRun = id => (ctx) => {
  if (ctx?.scenarioError !== undefined) return { status: 'failed', evidence: `headless scenario failed: ${ctx.scenarioError}` }
  return judge(id, ctx.obs, ctx.tools)
}
const item = (id, layer, title) => (layer === 'headless' && JUDGES[id] !== undefined ? { id, layer, title, run: headlessRun(id) } : { id, layer, title })

/** All 39 checklist items, in plan order. Add `run` to implement one. */
export const CHECKS = [
  item('H01', 'headless', '新目录初始化：.nexgent/ 布局与 config.json 存在；最近项目列表含该项目'),
  item('H02', 'headless', '添加 .csv 与 .xlsx 两份资料：复制到 materials/<id>/，元数据通过 schema，SHA-256 一致，原文件未改'),
  item('H03', 'headless', '首轮请求含两份资料的引用；模型写 materials/ 被拒'),
  item('H04', 'headless', '.xlsx 资料经 Office 技能工具读出（load_skill 与读取工具的调用和结果）'),
  item('H05', 'headless', '工作区说明文件 AGENTS.md 的内容出现在系统提示'),
  item('H06', 'headless', '首轮 turn.end 为 completed；有 write_file 与 str_replace 的成功调用'),
  item('H07', 'headless', 'present 后有 deliverable.presented；outputs/<id>/v1/ 快照哈希一致；成果元数据通过 schema'),
  item('H08', 'headless', 'turn.files 与实际改动一致（含一处经 bash / pwsh 修改的文件）'),
  item('H09', 'headless', '反馈（评分 + 评语，关联 v1）：有 feedback 记录与 source: feedback 的用户消息'),
  item('H10', 'headless', '修改轮后有 v2；v1 快照哈希不变；v1→v2 差异非空且只涉及预期文件'),
  item('H11', 'headless', '持久目标：设定后写入；完成时状态更新'),
  item('H12', 'headless', '进程内取消：已流出文本保留，turn.end 为 cancelled；长 shell 命令被终止，无残留子孙进程'),
  item('H13', 'headless', '审批：工作区外写入触发审批，拒绝后工具结果为拒绝；once 批准只生效一次'),
  item('H14', 'headless', '压缩：越过测试阈值后写出 compaction 记录，下一次请求只带摘要与近期轮次'),
  item('H15', 'headless', '强杀一：模型流到一半强杀进程（Windows 结束整个进程树）'),
  item('H16', 'headless', '强杀二：工具执行到一半强杀进程'),
  item('H17', 'headless', '强杀后恢复：中断轮写成 interrupted；续聊请求含完整历史并回放 providerContent'),
  item('H18', 'headless', '恢复后经 SDK 查询：历史、两份资料、v1 / v2、反馈、目标全部可见且与强杀前一致'),
  item('H19', 'headless', '会话 seq 连续、记录通过 schema；账本请求开始 / 结束配对，每轮一条 task.outcome'),
  item('H20', 'headless', '.nexgent/ 与 export 产物中搜不到测试密钥值'),
  item('H21', 'headless', 'perProject 上限达到时以 budget/exhausted 结束，记录符合 permissions.md'),
  item('H22', 'headless', 'nexgent export <session> 产物包含会话、相关账本行与元数据'),
  item('D01', 'desktop', '应用启动，窗口加载，渲染进程控制台无错误；窗口配置满足隔离要求'),
  item('D02', 'desktop', '新建项目、从最近项目重新打开'),
  item('D03', 'desktop', '添加资料（对话框打桩）后右栏资料列表出现两项'),
  item('D04', 'desktop', '发送消息后中栏出现流式文本与工具活动块'),
  item('D05', 'desktop', '审批对话框出现，选择后轮次继续'),
  item('D06', 'desktop', '成果卡片出现；反馈后出现 v2，差异视图显示 v1→v2 的变化'),
  item('D07', 'desktop', '停止按钮取消当前轮，已流出文本保留在界面和会话里'),
  item('D08', 'desktop', '强杀主进程后重启：对话、资料与成果都在，继续对话成功'),
  item('D09', 'desktop', '设置页修改模型、thinking 与费用上限后写入 config.json；密钥只显示是否配置与来源'),
  item('D10', 'desktop', '无令牌或错令牌的 IPC 调用被拒'),
  item('R01', 'real', '真实任务结果由隐藏检查判定通过（数值、文件结构、测试）'),
  item('R02', 'real', '至少一次 write_file 与一次 str_replace 成功；修改轮对已有文件的修改有一次走 str_replace'),
  item('R03', 'real', 'thinking 开启：会话含 thinking 块；恢复后的续聊请求被 API 接受（无 400）'),
  item('R04', 'real', '真实请求流中途强杀，新进程恢复后完成；被打断的请求在账本有记录，用量缺失记 unknown'),
  item('R05', 'real', '链路覆盖：资料、present、反馈、v2、强杀、恢复全部发生'),
  item('R06', 'real', '（可选，不进门槛）Windows 上 R01–R05 全部通过，shell 工具为 pwsh'),
  item('R07', 'real', '请求数、token、unknown 数、估算费用写进摘要；费用不超过本次上限'),
]

/** Items that do not count toward the exit criteria. */
export const OPTIONAL_CHECKS = new Set(['R06'])

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

const ITEM_STATUSES = new Set(['passed', 'failed', 'not-implemented'])

/**
 * Evaluate one checklist item. A missing `run` is `not-implemented`; a
 * throw or a malformed result is `failed`.
 * @returns `{ status: 'passed' | 'failed' | 'not-implemented', evidence: string }`.
 */
export async function evaluateItem(entry, ctx) {
  if (typeof entry.run !== 'function') return { status: 'not-implemented', evidence: 'not implemented yet' }
  try {
    const result = await entry.run(ctx)
    if (result !== null && typeof result === 'object' && ITEM_STATUSES.has(result.status)) {
      return { status: result.status, evidence: String(result.evidence ?? '') }
    }
    if (result === null || typeof result !== 'object' || typeof result.pass !== 'boolean') {
      return { status: 'failed', evidence: `check returned ${JSON.stringify(result)} instead of { pass, evidence }` }
    }
    return { status: result.pass ? 'passed' : 'failed', evidence: String(result.evidence ?? '') }
  } catch (error) {
    return { status: 'failed', evidence: error instanceof Error ? (error.stack ?? error.message) : String(error) }
  }
}

/**
 * Exit code from item outcomes plus layer readiness.
 * Any real failure → 1; otherwise anything not implemented or not runnable → 2;
 * otherwise 0. No outcomes at all is never a pass.
 * @param statuses - item statuses.
 * @param notReady - number of selected layers whose prerequisites are missing.
 */
export function decideExit(statuses, notReady = 0) {
  if (statuses.includes('failed')) return EXIT_FAIL
  if (notReady > 0 || statuses.length === 0 || statuses.includes('not-implemented')) return EXIT_NOT_READY
  return EXIT_PASS
}

/**
 * Real-model budget gate: refuse to start a run once the estimated spend of
 * earlier runs has reached the cap (plan §预估费用: 15 USD).
 * @param capUsd - the cap.
 * @param spentUsd - estimated spend of earlier runs (USD each; 'unknown' entries block).
 * @returns `{ ok: true, remainingUsd }` or `{ ok: false, reason }`.
 */
export function budgetGate(capUsd, spentUsd) {
  if (!(typeof capUsd === 'number' && capUsd > 0)) return { ok: false, reason: `invalid budget cap ${capUsd}` }
  if (spentUsd.some(value => typeof value !== 'number' || !(value >= 0))) {
    return { ok: false, reason: 'an earlier run has an unknown cost; settle it before starting another run' }
  }
  const spent = spentUsd.reduce((sum, value) => sum + value, 0)
  if (spent >= capUsd) return { ok: false, reason: `estimated spend ${spent.toFixed(2)} USD has reached the ${capUsd} USD cap` }
  return { ok: true, remainingUsd: capUsd - spent }
}

/**
 * Which env var supplies the real-model key, without reading its value out.
 * @returns the variable name, or undefined when none is set.
 */
export function realModelKeySource(env) {
  return REAL_MODEL.keyEnv.find(name => typeof env[name] === 'string' && env[name].length > 0)
}
