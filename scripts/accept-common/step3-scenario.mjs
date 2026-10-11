/**
 * The step-3 acceptance scenario for the scripted model server, as data plus
 * request-aware entries (docs/plan/step-3-work-partition.md §`accept-step3`
 * 检查项清单). Requests are routed per session (test-support `routeByMember`):
 * the root session answers from `lead`, each member from its own queue, keyed
 * by the `Member: <name> (<form>)` line of its system prompt.
 *
 * Phases:
 *   direct    one turn, no members: write_file → present → answer (H01, H10, H22)
 *   delegation project (one root session, one turn per phase):
 *     setup      a plain question/answer turn the fork must see and fresh must not
 *     fresh      delegate `analyst` (fresh, the stock.csv material) → it writes and
 *                presents analysis/summary.md → the root writes final/report.md and
 *                presents it with the analyst's file (H02, H04)
 *     fork       delegate `forker` (fork) → it answers from the copied history (H03)
 *     forkKill   in a child process: delegate `forker-two` (fork), whose reply stalls;
 *                the process is killed there (H03 recovery)
 *     resume     after the kill: a plain turn
 *     sameName   two delegates in one step, both present shared/notes.md (H16)
 *   read-only project (sandbox read-only, two project presets):
 *     readonly   delegate with preset `wide` (workspace-write: refused, no member),
 *                then `quiet` with preset `noshell` (denies the shell tool) (H12)
 *   H15 reads the tool lists of every member request against the root's.
 */

/** Fixed test key; the scripted server never checks it. */
export const SCRIPTED_API_KEY = 'nexgent-accept-step3-scripted-key'

/** Project files the scenario writes. */
export const FILES = {
  plan: { path: 'plan/restock.md', content: '# Restock plan\n\nP01: order 30 units.\n' },
  summary: { path: 'analysis/summary.md', content: '# Stock summary\n\nANALYST-SUMMARY-MARKER: 6 SKUs, 2 above target.\n' },
  report: { path: 'final/report.md', content: '# Final report\n\nBased on analysis/summary.md by the analyst.\n' },
  shared: { path: 'shared/notes.md', a: 'NOTES-FROM-A\n', b: 'NOTES-FROM-A\nNOTES-FROM-B\n' },
}

/** The material the fresh member receives by id. */
export const MATERIAL = { name: 'stock.csv', content: 'sku,on_hand\nP01,14\nP02,9\n' }

/** Text only the setup turn carries: a fork must see it, a fresh member must not. */
export const HISTORY_MARKER = 'PARENT-HISTORY-MARKER'

/** Text the forker-two reply streams before it stalls (the kill point). */
export const STALL_TEXT = 'Double-checking the supplier'

/** Project presets of the read-only project (`.nexgent/presets/<name>.json`). */
export function readonlyPresets() {
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  return {
    shell,
    files: {
      wide: { formatVersion: 1, name: 'wide', description: 'Asks for a wider sandbox than the parent.', sandboxMode: 'workspace-write' },
      noshell: { formatVersion: 1, name: 'noshell', description: 'No shell tool.', tools: { deny: [shell] } },
    },
  }
}

/** Turn texts, used both as the user's message and to recognise requests. */
export const TASKS = {
  direct: 'Write a short restock plan into plan/restock.md and present it.',
  setup: `Remember this: the preferred supplier is ACME (${HISTORY_MARKER}).`,
  fresh: 'Have an analyst summarise the stock material, then present the final report.',
  fork: 'Ask a forked helper which supplier I prefer.',
  forkKill: 'Ask another forked helper to double-check the supplier.',
  resume: 'Continue after the crash: say where we are.',
  sameName: 'Have two writers each produce shared/notes.md.',
  readonly: 'Try a member with the wide preset, then one with the noshell preset.',
}

/** Member tasks (what the root passes to `delegate`). */
export const MEMBER_TASKS = {
  analyst: 'Summarise the stock material into analysis/summary.md and present it.',
  forker: 'Which supplier does the user prefer? Answer in one line.',
  forkerTwo: 'Double-check which supplier the user prefers.',
  writerA: 'Create shared/notes.md with your notes and present it.',
  writerB: 'Add your notes to shared/notes.md and present it.',
  wide: 'This member should never start.',
  quiet: 'Say which tools you have.',
}

const usage = { inputTokens: 300, outputTokens: 30, totalTokens: 330, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

/**
 * Script entries per phase: `{ lead, routes }` for `scriptedModelServer`.
 * @param h - the loaded test-support harness.
 * @param state - filled by the scenario before the phases run: `materialId`.
 */
export function buildStep3Script(h, state = {}) {
  const mentions = needle => body => h.requestText(body).includes(needle)
  const noMemberLine = body => !/^Member: /m.test(h.sessionText(body))
  /** The latest user turn of a request mentions `needle` (the turn being answered). */
  const turnOf = needle => (body) => {
    const users = (body?.messages ?? []).filter(message => message.role === 'user' && (typeof message.content === 'string' || (Array.isArray(message.content) && message.content.some(block => block?.type === 'text'))))
    return users.length > 0 && h.requestText({ messages: [users.at(-1)] }).includes(needle)
  }
  const member = name => body => h.sessionText(body).includes(`Member: ${name} (`)
  const delegate = (id, args) => ({ id, name: 'delegate', arguments: args })
  const answer = text => ({ content: text, usage })
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
    delegation: {
      lead: [
        // setup
        h.expectRequest('setup turn', turnOf(HISTORY_MARKER), answer('Noted: ACME is the preferred supplier.')),
        // fresh
        h.expectRequest('fresh turn', turnOf(TASKS.fresh), () => ({
          toolCalls: [delegate('call-analyst', { name: 'analyst', task: MEMBER_TASKS.analyst, mode: 'fresh', materialIds: state.materialId === undefined ? [] : [state.materialId], expectedOutput: FILES.summary.path })],
          usage,
        })),
        h.expectRequest('analyst result', mentions(TASKS.fresh), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.report.path, content: FILES.report.content } }], usage }),
        h.expectRequest('report written', mentions(TASKS.fresh), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.report.path, FILES.summary.path], summary: 'Final report with the analyst summary.' } }], usage }),
        h.expectRequest('final presented', mentions(TASKS.fresh), answer('Final report presented.')),
        // fork
        h.expectRequest('fork turn', turnOf(TASKS.fork), { toolCalls: [delegate('call-forker', { name: 'forker', task: MEMBER_TASKS.forker, mode: 'fork' })], usage }),
        h.expectRequest('forker result', mentions(TASKS.fork), answer('The helper says ACME.')),
        // sameName
        h.expectRequest('same-name turn', turnOf(TASKS.sameName), {
          toolCalls: [
            delegate('call-writer-a', { name: 'writer-a', task: MEMBER_TASKS.writerA }),
            delegate('call-writer-b', { name: 'writer-b', task: MEMBER_TASKS.writerB }),
          ],
          usage,
        }),
        h.expectRequest('writers results', mentions(TASKS.sameName), answer('Both writers presented shared/notes.md.')),
      ],
      routes: {
        analyst: [
          h.expectRequest('analyst first request', member('analyst'), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.summary.path, content: FILES.summary.content } }], usage }),
          h.expectRequest('analyst write result', member('analyst'), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.summary.path], summary: 'Stock summary.' } }], usage }),
          h.expectRequest('analyst present result', member('analyst'), answer('Summary written to analysis/summary.md and presented.')),
        ],
        forker: [h.expectRequest('forker first request', member('forker'), answer('ACME.'))],
        'writer-a': [
          h.expectRequest('writer-a first request', member('writer-a'), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.shared.path, content: FILES.shared.a } }], usage }),
          h.expectRequest('writer-a write result', member('writer-a'), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.shared.path], summary: 'Notes from A.' } }], usage }),
          h.expectRequest('writer-a present result', member('writer-a'), answer('Notes A presented.')),
        ],
        'writer-b': [
          h.expectRequest('writer-b first request', member('writer-b'), { toolCalls: [{ name: 'str_replace', arguments: { path: FILES.shared.path, old_str: FILES.shared.a, new_str: FILES.shared.b } }], usage }),
          h.expectRequest('writer-b edit result', member('writer-b'), { toolCalls: [{ name: 'present', arguments: { paths: [FILES.shared.path], summary: 'Notes from B.' } }], usage }),
          h.expectRequest('writer-b present result', member('writer-b'), answer('Notes B presented.')),
        ],
      },
    },
    forkKill: {
      lead: [h.expectRequest('fork-kill turn', turnOf(TASKS.forkKill), { toolCalls: [delegate('call-forker-two', { name: 'forker-two', task: MEMBER_TASKS.forkerTwo, mode: 'fork' })], usage })],
      routes: {
        'forker-two': [h.expectRequest('forker-two first request', member('forker-two'), { content: [STALL_TEXT, ' and more'], fault: { kind: 'timeout', afterChunks: 3 }, usage })],
      },
    },
    resume: {
      lead: [h.expectRequest('resume turn', turnOf(TASKS.resume), answer('We are past the crash; the supplier is ACME.'))],
      routes: {},
    },
    readonly: {
      lead: [
        h.expectRequest('read-only turn', turnOf(TASKS.readonly), { toolCalls: [delegate('call-wide', { name: 'wide-one', task: MEMBER_TASKS.wide, preset: 'wide' })], usage }),
        h.expectRequest('wide refused', mentions(TASKS.readonly), { toolCalls: [delegate('call-quiet', { name: 'quiet', task: MEMBER_TASKS.quiet, preset: 'noshell' })], usage }),
        h.expectRequest('quiet result', mentions(TASKS.readonly), answer('Done.')),
      ],
      routes: {
        quiet: [h.expectRequest('quiet first request', member('quiet'), answer('I have read-only tools and no shell.'))],
      },
    },
  }
}
