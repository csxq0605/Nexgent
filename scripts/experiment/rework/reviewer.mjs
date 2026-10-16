// @ts-check
/**
 * The external reviewer of the rework measurement (ADR 0019 §8: it only reports, never
 * enters the loop): `claude-opus-5-5`, thinking on, prompt frozen in the plan. It judges
 * every checked point of a holdout run — yes / no / can't tell — from the task, the
 * starting files and the delivered files; the report gives its agreement with the
 * deterministic judges. Its verdicts change no score, are written into no project and
 * never become feedback.
 *
 * The model call is injected (`complete(request) → { text, usd }`, as in the pilot), so the
 * prompt and parsing are tested with a scripted backend. Prompt layout and parsing reuse
 * the pilot's (`../step6/pilot/reviewer.mjs`).
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { listFiles, readBytes } from './common.mjs'
import { EXTERNAL_REVIEWER, parsePointVerdicts, POINT_SYSTEM, scriptedComplete } from '../step6/pilot/reviewer.mjs'

export { EXTERNAL_REVIEWER, POINT_SYSTEM, scriptedComplete }

/**
 * @typedef {import('./common.mjs').ReworkCase} ReworkCase
 * @typedef {import('../step6/pilot/reviewer.mjs').Complete} Complete
 * @typedef {import('../step6/pilot/reviewer.mjs').PointVerdict} PointVerdict
 */

/** Size limits of what the reviewer is shown (frozen). */
export const REVIEW_LIMITS = Object.freeze({ fileChars: 8000, totalChars: 60000 })

const utf8 = (/** @type {Uint8Array} */ bytes) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Text blocks of files (`【path】` then content), each cut at `fileChars`, all at `totalChars`;
 * binary files are named only.
 * @param {Array<[string, string | Uint8Array]>} files
 */
export function filesText(files) {
  const blocks = []
  let used = 0
  for (const [path, content] of files) {
    const text = typeof content === 'string' ? content : utf8(content)
    const body = text === null ? '（二进制文件）' : text.length > REVIEW_LIMITS.fileChars ? `${text.slice(0, REVIEW_LIMITS.fileChars)}\n（以下省略 ${text.length - REVIEW_LIMITS.fileChars} 字）` : text
    const block = `【${path}】\n${body}`
    if (used + block.length > REVIEW_LIMITS.totalChars) { blocks.push(`（其余 ${files.length - blocks.length} 个文件省略）`); break }
    blocks.push(block)
    used += block.length
  }
  return blocks.join('\n\n')
}

/**
 * The request that judges a run's checked points.
 * @param {ReworkCase} task
 * @param {Array<[string, string | Uint8Array]>} delivered output files, paths relative to the case folder
 * @returns {import('../step6/pilot/reviewer.mjs').ReviewRequest}
 */
export function reviewRequest(task, delivered) {
  const strip = (/** @type {string} */ path) => path.slice(task.folder.length + 1)
  const inputs = Object.entries(task.files).map(([path, content]) => /** @type {[string, string | Uint8Array]} */ ([strip(path), content]))
  const points = task.rubric.filter(point => point.by === 'check')
  const user = [
    `# 任务\n${task.message}`,
    `# 资料\n${filesText(inputs)}`,
    `# 成果\n${delivered.length === 0 ? '（没有交付文件）' : filesText(delivered)}`,
    `# 评分要点\n${points.map(point => `- ${point.id}：${point.text}`).join('\n')}`,
  ].join('\n\n')
  return { model: EXTERNAL_REVIEWER.model, thinking: EXTERNAL_REVIEWER.thinking, system: POINT_SYSTEM, user, maxTokens: EXTERNAL_REVIEWER.maxTokens }
}

/**
 * The delivered files of a run: every file under the case's output paths that the run
 * created or changed (starting files that are unchanged are left out).
 * @param {ReworkCase} task
 * @param {string} runRoot project directory of the run
 * @returns {Promise<Array<[string, Uint8Array]>>}
 */
export async function deliveredFiles(task, runRoot) {
  const starting = new Map(Object.entries(task.files).map(([path, content]) => [path, typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)]))
  const out = /** @type {Array<[string, Uint8Array]>} */ ([])
  for (const rel of await listFiles(runRoot, task.folder)) {
    const bytes = await readBytes(runRoot, rel)
    const before = starting.get(rel)
    if (before !== undefined && before.equals(Buffer.from(bytes))) continue
    out.push([rel.slice(task.folder.length + 1), bytes])
  }
  return out
}

/**
 * Judge a run's checked points.
 * @param {Complete} complete
 * @param {ReworkCase} task
 * @param {Array<[string, string | Uint8Array]>} delivered
 * @returns {Promise<{ verdicts: Record<string, { verdict: PointVerdict, reason: string }> | null, usd: number | null }>}
 */
export async function reviewRun(complete, task, delivered) {
  const ids = task.rubric.filter(point => point.by === 'check').map(point => point.id)
  try {
    const reply = await complete(reviewRequest(task, delivered))
    return { verdicts: parsePointVerdicts(reply.text, ids), usd: reply.usd }
  } catch {
    return { verdicts: null, usd: null }
  }
}
