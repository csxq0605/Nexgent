/**
 * Words of 能力 → 离线改进 (ADR 0026, ADR 0027; ADR 0020's plain-words
 * rule): what a run does, what it costs, what it found, and what the user
 * decides. Kept apart from `strings.ts` so the page's words read as one.
 */
import type { OfflineCandidate, OfflineRunState } from '@nexgent/kernel'
import { usdText } from './strings.js'

const dollars = (usd: number) => `${usdText(usd)} 美元`

export const O = {
  section: '离线改进',
  intro: '离线改进拿你做过、打过分的任务当练习题，在一份副本里重做，试着找出更好的做事说明和查经验的方式。只有在它没见过的题上也确实更好，才会推荐给你；你同意以后才生效，随时可以停用。',

  currentTitle: '现在在用',
  currentApplied: (day: string) => `离线改进得到的版本，${day}起用于所有项目的新任务。`,
  currentDefault: '默认设置：没有额外的做事说明，经验和技能按默认方式查找。',
  guidanceLabel: '做事说明',
  guidanceNone: '（没有）',
  retrievalLabel: '查找方式',
  retrieval: (r: OfflineCandidate['retrieval']) =>
    `每个任务最多查 ${r.handbookTopK} 条经验；一条经验要和任务至少有 ${r.handbookMinSharedTerms} 个相同的词、覆盖它自身内容的 ${Math.round(r.handbookMinCoverage * 100)}% 才算相关；每个任务最多用 ${r.skillMaxActive} 个学来的技能。`,
  revert: '停用，回到默认',
  revertConfirm: '确定停用',
  revertHelp: '停用后，新任务回到默认设置。已经在跑的任务不受影响。',

  practiceTitle: '练习题',
  practice: (c: { readonly train: number; readonly selection: number; readonly holdout: number; readonly guard: number }) =>
    `训练 ${c.train} 道 · 挑选 ${c.selection} 道 · 留出 ${c.holdout} 道 · 通用 ${c.guard} 道`,
  practiceHelp: '训练题和挑选题用来找新版本；留出题和通用题它看不到，只在最后用来检验。',
  practiceShort: '练习题还不够：训练、挑选、留出三类至少各要 1 道。做完并打过分的任务会自动变成练习题。',
  plan: '制定新计划',
  planHelp: '制定计划不花钱。计划会写明最多花多少钱，等你同意才开始。',

  runTitle: '最近一次',
  noRun: '还没有运行过。',
  planned: (iterations: number, cases: number) => `计划：最多试 ${iterations} 轮，用到 ${cases} 道练习题。每道题都在副本里真的重做一遍，会花模型费用。`,
  plannedCost: (estimate: number, cap: number) => `预计约 ${dollars(estimate)}，上限 ${dollars(cap)}。快超过上限时会自己停下。`,
  approve: (cap: number) => `同意上限 ${dollars(cap)}，开始`,
  approved: '已同意，正在启动。',
  running: (iteration: number, max: number) => `正在运行：第 ${Math.min(iteration + 1, max)} / ${max} 轮`,
  spent: (spent: number, cap: number) => `已花 ${dollars(spent)}，上限 ${dollars(cap)}`,
  versions: (n: number) => `已找到 ${Math.max(0, n - 1)} 个新版本`,
  stop: '停止',
  stopHelp: '会在当前这一步做完后停下，之后可以继续。',
  interrupted: '运行中断了（可能是电脑睡眠或应用退出）。',
  stopped: (reason: NonNullable<OfflineRunState['stop']>['reason'], detail: string) => STOP_TEXT[reason](detail),
  resume: '继续',
  budgetStopped: '再做下一步就会超过上限，所以停下了，没有得出结论。要继续，请制定新计划。',

  recommended: (cases: number, diff: number, low: number, high: number) =>
    `找到了更好的版本：在它没见过的 ${cases} 道题上，平均每题高 ${points(diff, false)} 分（满分 100；有 95% 的把握，差距在 ${points(low)} 到 ${points(high)} 分之间）。`,
  guardOk: '通用题上没有变差。',
  before: '原来',
  after: '新版本',
  apply: '采用这个版本',
  applyHelp: '采用后，所有项目的新任务都按新版本做。随时可以在上面停用。',
  decline: '不用',
  noBetter: '没有找到更好的版本：没有哪个版本在它没见过的题上稳定胜过原来的设置，所以什么都不改。',
  applied: (day: string) => `已在${day}采用。`,
  declined: (day: string) => `没有采用（${day}）。`,
  unchanged: '没有变化',

  historyTitle: (n: number) => `更早的运行 ${n}`,
  historyRow: (day: string, status: string, spent: number) => `${day} · ${status} · 花了 ${dollars(spent)}`,
  status: {
    'awaiting-approval': '等你同意',
    running: '运行中',
    stopped: '已停止',
    'awaiting-user': '已完成',
  } as Record<OfflineRunState['status'], string>,
  live: '运行中',
  statusApplied: '已采用',
  statusDeclined: '没有采用',
} as const

const STOP_TEXT: Record<NonNullable<OfflineRunState['stop']>['reason'], (detail: string) => string> = {
  budget: () => O.budgetStopped,
  'stop-file': () => '按你的要求停下了。',
  aborted: () => '运行被中断了。',
  error: detail => `出错停下了：${detail}`,
}

/** A 0–1 score difference as points out of 100, one decimal. */
function points(diff: number, signed = true): string {
  const value = Math.round(diff * 1000) / 10
  return `${signed && value > 0 ? '+' : ''}${value}`
}
