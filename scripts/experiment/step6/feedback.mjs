// @ts-check
/**
 * Simulated user feedback for the step-6 experiment (user decision 6): filled from
 * fixed templates by what the hidden judge found, never written by a model, so a
 * rerun of the same experiment sends the same words. Templates never mention
 * capability tools, skills or components.
 *
 * For a failed case: three counted entries (rating 2, no rating, rating 3) about the
 * most important problem, each worded differently; other problems are added to the
 * first entry in one short sentence each. For a passed case: one praise entry that
 * does not count (rating 5). For an unknown judge result: no feedback.
 *
 * Linux, macOS and Windows; no dependencies.
 */

/**
 * @typedef {{ key: string, rating?: 1 | 2 | 3 | 4 | 5, comment: string }} FeedbackEntry
 */

/**
 * Problem kinds, most important first: the task itself before the user's conventions, except
 * amounts that are not integer cents, which usually is why the hidden invoice tests fail too.
 */
export const PRIORITY = [
  'missing-output', 'invalid-output', 'missing-column', 'wrong-rows', 'wrong-value', 'convention-cents', 'hidden-test',
  'refactor-incomplete', 'convention-tests', 'finance-value', 'convention-column', 'convention-value',
]

/** Three wordings per kind; `{detail}` is the problem's detail (several joined with 、). */
export const TEMPLATES = {
  'missing-output': ['没看到 {detail}，这次的结果没交出来。', '{detail} 还是没有，请把结果放到我说的位置。', '以后请记得把结果存到要求的路径，这次是 {detail}。'],
  'invalid-output': ['结果文件打不开（{detail}）。', '交的文件格式不对：{detail}。', '请交一个能直接打开的文件，这次的不行（{detail}）。'],
  'missing-column': ['表里少了要求的列：{detail}。', '{detail} 列没有，这是任务里要的。', '请对照要求的列检查一遍，这次缺 {detail}。'],
  'wrong-rows': ['表的行不对：{detail}。', '行数或顺序对不上（{detail}）。', '请按要求的分组和顺序出表，这次的行不对：{detail}。'],
  'wrong-value': ['有数字不对，比如 {detail}。', '数字对不上：{detail}，请按任务里的口径重算。', '这次的数还是有错（{detail}），算完请核对一遍。'],
  'hidden-test': ['我拿几张发票核对了一下，有的算得不对（{detail}）。', '发票金额还是有错：{detail}，请对照规则再查。', '改完的结果和规则对不上（{detail}），请把各种情况都验证一遍。'],
  'refactor-incomplete': ['重构没做完：{detail}。', '说好的抽取没有做彻底：{detail}。', '请把重构做完整，这次还剩：{detail}。'],
  'convention-tests': ['改了 {detail} 这些模块，但 test/ 下没有对应模块的测试文件和用例。', '我们的规矩是改哪个模块，就在 test/ 下那个模块的测试文件里补用例，这次 {detail} 没补。', '又漏了测试：{detail}。以后每个改动或新增的模块都要有对应的 test/<模块>.test.js 和用例。'],
  'convention-cents': ['金额要用整数分，这次有金额不是整数分。', '我们所有金额一律按整数分存和算，这次又出现了小数。', '请记住：金额一律整数分，不要用元或带小数的数。'],
  'convention-column': ['表少了一列：平均客单价 {detail}（收入除以订单数，保留两位小数）。', '我们的汇总表一直都要带平均客单价那一列，这次又没有。', '还是缺 {detail}，以后每张按组汇总的表都要有这一列。'],
  // Hard cases: only where the table disagrees with finance, never why.
  'finance-value': ['这张表和财务的对账单对不上：{detail}。', '还是和财务对不上，比如 {detail}。财务那边的数是对的，请按财务的口径出表。', '财务又退回来了：{detail}。以后出表要和财务对得上。'],
  'convention-value': ['平均客单价算得不对（{detail}），应是该组收入除以订单数，保留两位小数。', '{detail}：平均客单价的数对不上。', '平均客单价请按收入 ÷ 订单数、保留两位小数来算，这次有错（{detail}）。'],
}

const FALLBACK = ['结果有问题：{detail}。', '还是不对：{detail}。', '请再检查一遍：{detail}。']

/** Short follow-up sentence for a secondary problem in the first entry. */
const SECONDARY = '另外，{detail}。'

const RATINGS = /** @type {const} */ ([2, undefined, 3])

/**
 * @param {string} template
 * @param {string} detail
 */
const fill = (template, detail) => template.replaceAll('{detail}', detail)

/**
 * Feedback for one finished case.
 * @param {import('./cases.mjs').JudgeResult} result
 * @returns {{ primary: string | null, entries: FeedbackEntry[] }}
 */
export function feedbackFor(result) {
  if (result.pass === null) return { primary: null, entries: [] }
  if (result.pass) return { primary: null, entries: [{ key: 'praise', rating: 5, comment: '这次的结果没问题，谢谢。' }] }
  /** @type {Map<string, string[]>} */
  const byKind = new Map()
  for (const issue of result.issues) {
    const list = byKind.get(issue.kind) ?? []
    if (!list.includes(issue.detail)) list.push(issue.detail)
    byKind.set(issue.kind, list)
  }
  const rank = (/** @type {string} */ kind) => (PRIORITY.indexOf(kind) < 0 ? PRIORITY.length : PRIORITY.indexOf(kind))
  const kinds = [...byKind.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const primary = kinds[0]
  const detailOf = (/** @type {string} */ kind) => /** @type {string[]} */ (byKind.get(kind)).slice(0, 3).join('、')
  const templates = /** @type {Record<string, string[]>} */ (TEMPLATES)[primary] ?? FALLBACK
  const entries = templates.map((template, index) => {
    let comment = fill(template, detailOf(primary))
    if (index === 0) for (const kind of kinds.slice(1)) comment += fill(SECONDARY, fill(/** @type {Record<string, string[]>} */ (TEMPLATES)[kind]?.[0] ?? '{detail}', detailOf(kind)).replace(/[。.]$/, ''))
    const rating = RATINGS[index]
    return rating === undefined ? { key: `fb${index + 1}`, comment } : { key: `fb${index + 1}`, rating, comment }
  })
  return { primary, entries }
}

/**
 * Whether an entry counts toward the improvement threshold (user decision, 2026-10-13):
 * a rating of 3 or less, or a comment without a rating.
 * @param {FeedbackEntry} entry
 */
export function counts(entry) {
  return entry.rating !== undefined ? entry.rating <= 3 : entry.comment.trim() !== ''
}
