// @ts-check
/**
 * The `memory` arm's one context policy (ADR 0011 decision 2): the raw text of every
 * counted feedback entry of the family, oldest first, under a fixed title. No diagnosis,
 * no proposal, no gate. When the text would exceed the context policy limit, the oldest
 * entries are dropped, so the newest are kept.
 *
 * Linux, macOS and Windows; no dependencies.
 */

export const MEMORY_POLICY = Object.freeze({
  name: 'project-notes',
  description: '用户以前对本项目成果的反馈（原文）',
  title: '用户以前对本项目成果的反馈（原文）',
  /** `CAPABILITY_LIMITS.maxInstructionBytes` in packages/kernel/src/contracts/capabilities.ts. */
  maxBytes: 16_384,
})

/**
 * The policy's `instructions`.
 * @param {ReadonlyArray<{ at: string, comment: string }>} entries counted feedback entries
 * @param {number} [maxBytes]
 * @returns {{ instructions: string, kept: number, dropped: number }}
 */
export function memoryInstructions(entries, maxBytes = MEMORY_POLICY.maxBytes) {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const render = (/** @type {typeof ordered} */ list) => `${MEMORY_POLICY.title}\n\n${list.map(entry => `- ${entry.comment}`).join('\n')}\n`
  let start = 0
  while (start < ordered.length && Buffer.byteLength(render(ordered.slice(start))) > maxBytes) start += 1
  return { instructions: render(ordered.slice(start)), kept: ordered.length - start, dropped: start }
}
