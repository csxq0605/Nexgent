/**
 * The step-3 acceptance scenario for the scripted model server, as data plus
 * request-aware entries (docs/plan/step-3-work-partition.md §`accept-step3`
 * 检查项清单). Requests are routed per session (test-support `routeByMember`):
 * the root session answers from `lead`, each member from its own queue, keyed
 * by the `Member: <name> (<form>)` line of its system prompt.
 *
 * Phases so far:
 *   direct    one turn, no members: write_file → present → answer (H01, H10, H22)
 *
 * Later rounds add the delegation, team and workflow phases as routes.
 */

/** Fixed test key; the scripted server never checks it. */
export const SCRIPTED_API_KEY = 'nexgent-accept-step3-scripted-key'

/** Project files the scenario writes. */
export const FILES = {
  plan: { path: 'plan/restock.md', content: '# Restock plan\n\nP01: order 30 units.\n' },
}

/** Turn texts, used both as the user's message and to recognise requests. */
export const TASKS = {
  direct: 'Write a short restock plan into plan/restock.md and present it.',
}

const usage = { inputTokens: 300, outputTokens: 30, totalTokens: 330, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

/**
 * Script entries per phase: `{ lead, routes }` for `scriptedModelServer`.
 * @param h - the loaded test-support harness.
 */
export function buildStep3Script(h) {
  const mentions = needle => body => h.requestText(body).includes(needle)
  const noMemberLine = body => !/^Member: /m.test(h.sessionText(body))
  return {
    direct: {
      lead: [
        h.expectRequest('direct turn (root session, no member line)', body => mentions(TASKS.direct)(body) && noMemberLine(body), {
          toolCalls: [{ name: 'write_file', arguments: { path: FILES.plan.path, content: FILES.plan.content } }],
          usage,
        }),
        h.expectRequest('write_file result', mentions(TASKS.direct), {
          toolCalls: [{ name: 'present', arguments: { paths: [FILES.plan.path], summary: 'Restock plan.' } }],
          usage,
        }),
        h.expectRequest('present result', mentions(TASKS.direct), { content: 'Plan presented.', usage }),
      ],
      routes: {},
    },
  }
}
