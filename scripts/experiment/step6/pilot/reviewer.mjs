// @ts-check
/**
 * The pilot's external reviewer (ADR 0011 decision 5): `claude-opus-5-5`, thinking on,
 * prompts frozen in `pilot-plan.json` before the pilot runs. It judges the review points
 * of a document, yes / no / can't tell, and compares two documents of the same task. It
 * never takes part in the improvement loop: its verdicts are not written into any
 * project and never become feedback.
 *
 * The model call is injected (`complete(request) → { text, usd }`), so the prompts and the
 * parsing are tested with a scripted backend; the real pilot binds it to the product's
 * Claude Platform client. The same point prompt with the gate's reviewer model gives the
 * in-loop reviewer's verdicts for the agreement report (reported, no threshold).
 *
 * Linux, macOS and Windows; no dependencies.
 */

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {{ model: string, thinking: 'on' | 'off', system: string, user: string, maxTokens: number }} ReviewRequest
 * @typedef {(request: ReviewRequest) => Promise<{ text: string, usd: number | null }>} Complete
 * @typedef {'yes' | 'no' | 'unclear'} PointVerdict
 * @typedef {'A' | 'B' | 'tie'} Preference
 */

export const EXTERNAL_REVIEWER = Object.freeze({ model: 'claude-opus-5-5', thinking: /** @type {const} */ ('on'), maxTokens: 16000 })
/** The in-loop reviewer for the agreement report: the gate's reviewer settings. */
export const IN_LOOP_REVIEWER = Object.freeze({ model: 'claude-sonnet-5-5', thinking: /** @type {const} */ ('on'), maxTokens: 16000 })

export const POINT_SYSTEM = [
  '你是一名独立评审，负责检查一份工作成果是否满足评分要点。',
  '只根据给出的任务、资料和成果判断，不要猜测资料以外的情况。',
  '对每个要点给出“是”“否”或“看不出”：满足写“是”，不满足写“否”，凭给出的内容确实无法判断时写“看不出”。',
  '每个要点用一句话说明理由。',
  '只输出一个 JSON 对象，不要输出其他文字：{"points":[{"id":"要点编号","verdict":"是|否|看不出","reason":"一句话"}]}',
].join('\n')

export const PAIR_SYSTEM = [
  '你是一名独立评审，负责比较同一任务的两份成果。',
  '比较的依据是任务要求、给出的资料和评分要点：内容是否准确、完整，是否有资料里没有的内容，结构是否清楚。不要因为篇幅长短或出现的先后本身偏向任何一份。',
  '先逐条列出两份之间会影响任务完成好坏的具体差别，每条写明哪一份更好、依据是哪个要点或哪份资料；措辞、排版、详略上不影响任务完成的差别不算。',
  '没有这样的差别，或差别互相抵消、分不出高下时，写 tie。',
  '只输出一个 JSON 对象，不要输出其他文字：{"differences":["一条差别"],"preference":"A|B|tie","reason":"一句话"}',
].join('\n')

/** Materials of a case as text blocks (file name, then content); materials sit under a `materials/` folder, in the case folder or not. @param {PilotCase} task */
function materialsText(task) {
  return Object.entries(task.files)
    .filter(([path]) => /(^|\/)materials\//.test(path))
    .map(([path, content]) => `【${path.slice(path.indexOf('materials/') + 'materials/'.length)}】\n${typeof content === 'string' ? content : '(二进制文件)'}`)
    .join('\n\n')
}

/**
 * The request that judges a document's review points.
 * @param {PilotCase} task
 * @param {string} document
 * @param {{ model: string, thinking: 'on' | 'off', maxTokens: number }} [reviewer]
 * @returns {ReviewRequest}
 */
export function pointRequest(task, document, reviewer = EXTERNAL_REVIEWER) {
  const points = task.rubric.filter(point => point.by === 'review')
  const user = [
    `# 任务\n${task.message}`,
    `# 资料\n${materialsText(task)}`,
    `# 成果（${task.outputs[0]}）\n${document}`,
    `# 评分要点\n${points.map(point => `- ${point.id}：${point.text}`).join('\n')}`,
  ].join('\n\n')
  return { model: reviewer.model, thinking: reviewer.thinking, system: POINT_SYSTEM, user, maxTokens: reviewer.maxTokens }
}

/**
 * The request that compares two documents of the same task (`first` shown as A). The scored
 * review points (not the taste points) are the basis of the comparison.
 * @param {PilotCase} task
 * @param {string} first
 * @param {string} second
 * @returns {ReviewRequest}
 */
export function pairRequest(task, first, second) {
  const points = task.rubric.filter(point => point.by !== 'none')
  const user = [
    `# 任务\n${task.message}`,
    `# 资料\n${materialsText(task)}`,
    `# 评分要点\n${points.map(point => `- ${point.id}：${point.text}`).join('\n')}`,
    `# 成果 A\n${first}`,
    `# 成果 B\n${second}`,
  ].join('\n\n')
  return { model: EXTERNAL_REVIEWER.model, thinking: EXTERNAL_REVIEWER.thinking, system: PAIR_SYSTEM, user, maxTokens: EXTERNAL_REVIEWER.maxTokens }
}

/** The last JSON object in a reply (fenced or bare), or null. @param {string} text */
export function lastJsonObject(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1])
  const candidates = [...fenced.reverse(), text]
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      const value = JSON.parse(candidate.slice(start, end + 1))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return /** @type {Record<string, unknown>} */ (value)
    } catch {
      continue
    }
  }
  return null
}

const VERDICTS = /** @type {Record<string, PointVerdict>} */ ({ 是: 'yes', 否: 'no', 看不出: 'unclear', yes: 'yes', no: 'no', unclear: 'unclear' })

/**
 * Point verdicts from a reply: one per asked id; an id the reply leaves out is missing (the
 * point stays unknown). An unreadable reply is `null` (the review failed).
 * @param {string} text
 * @param {readonly string[]} ids
 * @returns {Record<string, { verdict: PointVerdict, reason: string }> | null}
 */
export function parsePointVerdicts(text, ids) {
  const value = lastJsonObject(text)
  if (value === null || !Array.isArray(value.points)) return null
  /** @type {Record<string, { verdict: PointVerdict, reason: string }>} */
  const out = {}
  for (const item of value.points) {
    if (item === null || typeof item !== 'object') continue
    const id = String(/** @type {any} */ (item).id ?? '')
    const verdict = VERDICTS[String(/** @type {any} */ (item).verdict ?? '').trim()]
    if (!ids.includes(id) || verdict === undefined || id in out) continue
    out[id] = { verdict, reason: String(/** @type {any} */ (item).reason ?? '') }
  }
  return out
}

/**
 * A comparison reply: the preference, the reason, and the listed differences. A reply that lists
 * no difference (an empty `differences` array) is a tie whatever preference it names: the prompt
 * asks for tie when nothing affects the task, and a preference with no difference behind it is
 * what order effects look like. Null when unreadable.
 * @param {string} text
 * @returns {{ preference: Preference, reason: string, differences: string[] } | null}
 */
export function parsePairReply(text) {
  const value = lastJsonObject(text)
  const named = String(value?.preference ?? '').trim()
  if (named !== 'A' && named !== 'B' && named !== 'tie') return null
  const differences = Array.isArray(value?.differences) ? value.differences.map(d => String(d)) : null
  const preference = differences !== null && differences.length === 0 ? 'tie' : named
  return { preference, reason: String(value?.reason ?? ''), differences: differences ?? [] }
}

/** Preference from a reply, or null when unreadable. @param {string} text @returns {Preference | null} */
export const parsePreference = text => parsePairReply(text)?.preference ?? null

/**
 * Judge a document's review points.
 * @param {Complete} complete
 * @param {PilotCase} task
 * @param {string} document
 * @param {{ model: string, thinking: 'on' | 'off', maxTokens: number }} [reviewer]
 */
export async function reviewPoints(complete, task, document, reviewer = EXTERNAL_REVIEWER) {
  const ids = task.rubric.filter(point => point.by === 'review').map(point => point.id)
  if (ids.length === 0) return { verdicts: {}, usd: 0 }
  try {
    const reply = await complete(pointRequest(task, document, reviewer))
    return { verdicts: parsePointVerdicts(reply.text, ids), usd: reply.usd }
  } catch {
    return { verdicts: null, usd: null }
  }
}

/**
 * Compare two documents in both orders. `winner` maps the two answers back to the
 * documents: `first`, `second`, `tie`, or null when the orders disagree or a reply failed.
 * `replies` keeps each order's reason and differences (or the unreadable text, or the error),
 * so a disagreement can be read afterwards.
 * @param {Complete} complete
 * @param {PilotCase} task
 * @param {string} first
 * @param {string} second
 */
export async function comparePair(complete, task, first, second) {
  const ask = async (/** @type {string} */ a, /** @type {string} */ b) => {
    try {
      const reply = await complete(pairRequest(task, a, b))
      const parsed = parsePairReply(reply.text)
      return { preference: parsed?.preference ?? null, reply: parsed === null ? { unreadable: reply.text.slice(0, 2000) } : { reason: parsed.reason, differences: parsed.differences }, usd: reply.usd }
    } catch (error) {
      return { preference: null, reply: { failed: error instanceof Error ? error.message.slice(0, 500) : String(error) }, usd: null }
    }
  }
  const ab = await ask(first, second)
  const ba = await ask(second, first)
  return {
    ab: ab.preference, ba: ba.preference, ...orderOutcome(ab.preference, ba.preference),
    replies: { ab: ab.reply, ba: ba.reply },
    usd: ab.usd === null || ba.usd === null ? null : ab.usd + ba.usd,
  }
}

/**
 * Whether two orders agree, and on what. `ab` has the first document as A, `ba` as B.
 * @param {Preference | null} ab
 * @param {Preference | null} ba
 * @returns {{ consistent: boolean | null, winner: 'first' | 'second' | 'tie' | null }}
 */
export function orderOutcome(ab, ba) {
  if (ab === null || ba === null) return { consistent: null, winner: null }
  if (ab === 'tie' && ba === 'tie') return { consistent: true, winner: 'tie' }
  if (ab === 'A' && ba === 'B') return { consistent: true, winner: 'first' }
  if (ab === 'B' && ba === 'A') return { consistent: true, winner: 'second' }
  return { consistent: false, winner: null }
}

/**
 * A scripted backend for tests and rehearsals: `answer(request)` returns the reply text.
 * @param {(request: ReviewRequest) => string} answer
 * @returns {Complete}
 */
export const scriptedComplete = answer => async request => ({ text: answer(request), usd: 0 })
