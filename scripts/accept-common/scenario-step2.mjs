/**
 * The step-2 acceptance scenario for the scripted model server, as data plus
 * request-aware entries (docs/plan/step-2-work-partition.md §`accept-step2`
 * 检查项清单; docs/spec/agent-hooks.md for the order of a turn).
 *
 * Every entry checks that the request it answers is the one the scenario
 * expects (HTTP 418 naming the expectation otherwise), so a drifting run
 * fails at the request that drifted instead of answering the wrong one.
 *
 * Phases (one CLI / SDK process each unless noted):
 *   first     materials → load_skill + read_document → write into materials/
 *             (refused) → writes (write_file, str_replace, shell) → present v1 → answer
 *   feedback  feedback on v1 → str_replace → present v2 (same deliverable) → answer
 *   goal      a turn while a goal is active: its text is in the system prompt
 *   pause     a reply ending in pause_turn → continuation → answer
 *   compactFail  a tool call reporting input above the threshold → summary
 *             request fails (HTTP 500) → the next request carries the full history
 *   compact   the same, but the summary succeeds → the next request carries
 *             the summary instead of the early turns
 *   approvals write outside the project (asks; denied) → write
 *             .env (approval: allowed once) → write .env again (asked again: denied)
 *   cancelStream  a reply that stalls mid-stream (the host cancels there)
 *   cancelTool    a long shell command (the host cancels while it runs)
 *   streamKill    a reply that stalls mid-stream (the process is killed there)
 *   resumeAfterStream  after that kill: the request carries the history → answer
 *   toolKill      a long shell command (the process is killed while it runs)
 *   resumeAfterTool    after that kill: the request carries the history → answer
 *   budget    two one-request turns in a project whose perProject cap is one request
 *
 * `h` is the loaded test-support harness (`expectRequest`, `compactionSummary`,
 * `failCompaction`, `requestText`, `isAuxiliaryRequest`).
 */

/** WIRE: the built-in Office skill's name in `@nexgent/skill` (W3); adapt when it lands. */
export const OFFICE_SKILL = 'office-documents'

/** Fixed test key; the scripted server never checks it. */
export const SCRIPTED_API_KEY = 'nexgent-accept-step2-scripted-key'

/** Compaction threshold for the run (`NEXGENT_COMPACTION_THRESHOLD`) and the input a reply reports to cross it. */
export const COMPACTION = { threshold: 2_000, reportedInput: 50_000, summary: 'SUMMARY-OF-EARLIER-TURNS: report built from orders.csv and regions.xlsx; v1 presented; feedback applied in v2.' }

/** Materials the run adds (contents are written by the acceptance script). */
export const MATERIALS = { csv: 'orders.csv', xlsx: 'regions.xlsx' }

/** Project files the scenario writes and their contents. */
export const FILES = {
  summary: { path: 'report/summary.csv', v1: 'region,month,total\nnorth,2026-09,1200.00\n', v2: 'region,month,total,mom\n北区,2026-09,1200.00,\n' },
  readme: { path: 'report/README.md', initial: '# Sales report\n\nTODO cleaning rules\n', edited: '# Sales report\n\nCleaning: dedupe order ids, drop empty regions, strip thousands separators.\n' },
  shellNote: { path: 'report/notes.txt', line: 'written by the shell tool' },
  outside: { path: '../outside-the-project.txt', content: 'must be refused' },
  env: { path: '.env', allowed: 'TOKEN=allowed-once\n', denied: 'TOKEN=asked-again\n' },
}

/** Turn texts, used both as the user's message and to recognise requests. */
export const TASKS = {
  first: 'Clean the orders, summarise sales by region and month into report/summary.csv with a README, then present it.',
  feedback: 'Use the Chinese region names from the lookup table and add a month-over-month column.',
  compactFail: 'Add a chart description to the README.',
  compact: 'Add a second chart description to the README.',
  pause: 'Look up the latest exchange rates and note them.',
  goal: 'Keep going towards the goal.',
  goalText: 'Deliver a monthly sales report the finance team can rerun.',
  approvals: 'Store the export token in .env.',
  cancelStream: 'Draft the release notes (this turn is cancelled mid-stream).',
  cancelTool: 'Run the long consistency check (this turn is cancelled while the command runs).',
  streamKill: 'Write a long design note about the report (this turn is killed mid-stream).',
  resumeAfterStream: 'Continue after the crash: summarise what is done so far.',
  toolKill: 'Run the slow data check (this turn is killed while the command runs).',
  resumeAfterTool: 'Continue after the second crash: list the deliverables.',
  budget: 'Count the orders.',
}

const usage = { inputTokens: 400, outputTokens: 40, totalTokens: 440, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const overThreshold = { ...usage, inputTokens: COMPACTION.reportedInput, totalTokens: COMPACTION.reportedInput + usage.outputTokens }

/** The shell tool and a command for the current platform. */
export function shellCall(command) {
  return process.platform === 'win32' ? { name: 'pwsh', arguments: { command: command.pwsh } } : { name: 'bash', arguments: { command: command.bash } }
}

/** Appends one line to the shell-written file (H08). */
export const APPEND_NOTE = {
  bash: `mkdir -p report && echo '${FILES.shellNote.line}' >> ${FILES.shellNote.path}`,
  pwsh: `New-Item -ItemType Directory -Force report | Out-Null; Add-Content -Path ${FILES.shellNote.path} -Value '${FILES.shellNote.line}'`,
}

/** Partial text streamed before a stall (H12, H15). */
export const STALL_TEXT = { cancel: 'Release notes, part one', kill: 'Design note, part one' }

/** A command that runs long enough to be killed mid-tool (H12, H16). */
export const SLOW_COMMAND = { bash: 'sleep 120', pwsh: 'Start-Sleep -Seconds 120' }

/** The material path the model is shown for `name` (`.nexgent/materials/<id>/<name>`), from the request text. */
export function materialPath(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:[^\\s"'\`(]*[\\\\/])?materials[\\\\/][^\\s"'\`)]+?[\\\\/]${escaped}`).exec(text)?.[0]?.replaceAll('\\', '/')
}

/** The deliverable id a feedback prompt or a present result names. */
export function deliverableIdFrom(text) {
  return /Feedback on deliverable (\S+) version \d+/.exec(text)?.[1] ?? /Presented deliverable ([0-9a-f-]{36})/.exec(text)?.[1]
}

/**
 * Since a compaction keeps the user's own words verbatim after its summary (kernel
 * `USER_WORDS_HEADING`, 2026-10-19), the early turns count as gone when their text
 * appears nowhere else: these split a request into that section and the rest.
 */
export const USER_WORDS_HEADING = "## The user's own words (verbatim, oldest first)"
const messageTexts = (requestText, body) => (body?.messages ?? []).map(message => requestText({ messages: [message] }))
/** The user-words section of a request, empty when there is none. */
export const userWordsSection = (requestText, body) => messageTexts(requestText, body).map(text => (text.includes(USER_WORDS_HEADING) ? text.slice(text.indexOf(USER_WORDS_HEADING)) : '')).join('\n')
/** A request's system and message text with the user-words section cut out. */
export const outsideUserWordsText = (requestText, body) => [requestText({ system: body?.system }), ...messageTexts(requestText, body).map(text => (text.includes(USER_WORDS_HEADING) ? text.slice(0, text.indexOf(USER_WORDS_HEADING)) : text))].join('\n')

/** Whether the latest user turn of a request mentions `needle` (the turn being answered). */
export function lastUserMentions(body, needle, h) {
  const users = (body?.messages ?? []).filter(message => message.role === 'user')
  return users.length > 0 && h.requestText({ messages: [users.at(-1)] }).includes(needle)
}

/**
 * Script entries per phase. Each phase's array answers that phase's requests in order.
 * @param h - the loaded test-support harness.
 */
export function buildStep2Script(h) {
  const mentions = needle => body => h.requestText(body).includes(needle)
  const first = [
    h.expectRequest('first turn with both materials referenced', body => mentions(TASKS.first)(body) && mentions(MATERIALS.csv)(body) && mentions(MATERIALS.xlsx)(body), {
      reasoning: 'Plan: read both materials with the Office skill, then write the report.',
      toolCalls: [{ name: 'load_skill', arguments: { name: OFFICE_SKILL } }],
      usage,
    }),
    h.expectRequest('load_skill result', mentions(TASKS.first), (body) => {
      const path = materialPath(h.requestText(body), MATERIALS.xlsx) ?? `.nexgent/materials/unknown/${MATERIALS.xlsx}`
      return { toolCalls: [{ name: 'read_document', arguments: { path } }], usage }
    }),
    h.expectRequest('read_document result', mentions(TASKS.first), (body) => {
      const csv = materialPath(h.requestText(body), MATERIALS.csv) ?? `.nexgent/materials/unknown/${MATERIALS.csv}`
      // Writing into materials/ must be refused (H03).
      return { toolCalls: [{ name: 'write_file', arguments: { path: csv, content: 'tampered\n' } }], usage }
    }),
    h.expectRequest('refused materials write', mentions(TASKS.first), {
      toolCalls: [
        { name: 'write_file', arguments: { path: FILES.summary.path, content: FILES.summary.v1 } },
        { name: 'write_file', arguments: { path: FILES.readme.path, content: FILES.readme.initial } },
      ],
      usage,
    }),
    h.expectRequest('write_file results', mentions(TASKS.first), {
      toolCalls: [
        { name: 'str_replace', arguments: { path: FILES.readme.path, old_str: 'TODO cleaning rules', new_str: 'Cleaning: dedupe order ids, drop empty regions, strip thousands separators.' } },
        shellCall(APPEND_NOTE),
      ],
      usage,
    }),
    h.expectRequest('edit results', mentions(TASKS.first), {
      toolCalls: [{ name: 'present', arguments: { paths: [FILES.summary.path, FILES.readme.path], summary: 'Sales by region and month, with cleaning rules.' } }],
      usage,
    }),
    h.expectRequest('present result', mentions(TASKS.first), { content: ['Report ready: ', 'report/summary.csv.'], usage }),
  ]
  const feedback = [
    h.expectRequest('feedback turn on v1', body => lastUserMentions(body, 'Feedback on deliverable', h) && lastUserMentions(body, TASKS.feedback, h), {
      toolCalls: [{ name: 'str_replace', arguments: { path: FILES.summary.path, old_str: FILES.summary.v1, new_str: FILES.summary.v2 } }],
      usage,
    }),
    h.expectRequest('str_replace result', mentions(TASKS.feedback), (body) => {
      const deliverableId = deliverableIdFrom(h.requestText(body))
      return {
        toolCalls: [{ name: 'present', arguments: { paths: [FILES.summary.path, FILES.readme.path], summary: 'Chinese region names and a month-over-month column.', ...(deliverableId === undefined ? {} : { deliverableId }) } }],
        usage,
      }
    }),
    h.expectRequest('present v2 result', mentions(TASKS.feedback), { content: 'Updated: v2 presented.', usage }),
  ]
  // The trigger reads the latest request's usage before the next request, so
  // the over-threshold reply must call a tool to get a next request in the same turn.
  const overThresholdCall = text => ({
    toolCalls: [{ name: 'str_replace', arguments: { path: FILES.readme.path, old_str: 'strip thousands separators.', new_str: `strip thousands separators.\n${text}` } }],
    usage: overThreshold,
  })
  const compactFail = [
    h.expectRequest('compactFail turn', body => lastUserMentions(body, TASKS.compactFail, h), overThresholdCall('Chart: monthly totals per region.')),
    h.failCompaction(500),
    h.expectRequest('request with the uncompacted history', body => mentions(TASKS.first)(body) && mentions(TASKS.compactFail)(body), { content: 'Continuing without compaction.', usage }),
  ]
  const compact = [
    h.expectRequest('compact turn', body => lastUserMentions(body, TASKS.compact, h), overThresholdCall('Chart: share per region.')),
    h.compactionSummary(COMPACTION.summary, usage),
    h.expectRequest('first request after compaction (summary, no early turns)', body => mentions(COMPACTION.summary)(body) && !outsideUserWordsText(h.requestText, body).includes(TASKS.first) && mentions(TASKS.compact)(body), { content: 'Continuing from the summary.', usage }),
  ]
  const pause = [
    h.expectRequest('pause turn', body => lastUserMentions(body, TASKS.pause, h), { content: 'Searching for rates...', finishReason: 'pause', usage }),
    h.expectRequest('pause continuation (no new user message)', body => lastUserMentions(body, TASKS.pause, h) && (body.messages ?? []).at(-1)?.role === 'assistant', { content: 'Rates noted.', usage }),
  ]
  const goal = [
    h.expectRequest('turn with the active goal in the system prompt', body => h.requestText({ system: body.system }).includes(TASKS.goalText), { content: 'Working towards the goal.', usage }),
  ]
  const approvals = [
    h.expectRequest('approvals turn', body => lastUserMentions(body, TASKS.approvals, h), {
      // Kept after the compaction: the thinking block whose replay H17 checks after the kills.
      reasoning: 'The outside path needs approval; .env needs approval.',
      toolCalls: [{ name: 'write_file', arguments: { path: FILES.outside.path, content: FILES.outside.content } }],
      usage,
    }),
    h.expectRequest('outside write result', mentions(TASKS.approvals), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.env.path, content: FILES.env.allowed } }], usage }),
    h.expectRequest('first .env write result', mentions(TASKS.approvals), { toolCalls: [{ name: 'write_file', arguments: { path: FILES.env.path, content: FILES.env.denied } }], usage }),
    h.expectRequest('second .env write result', mentions(TASKS.approvals), { content: 'Token stored once; the second write was not approved.', usage }),
  ]
  // message_start, content_block_start, one text_delta, then the stream stalls.
  const stall = (label, task, text) => h.expectRequest(label, body => lastUserMentions(body, task, h), { content: [text], fault: { kind: 'timeout', afterChunks: 3 } })
  const slow = (label, task) => h.expectRequest(label, body => lastUserMentions(body, task, h), { content: 'Starting the check.', toolCalls: [shellCall(SLOW_COMMAND)], usage })
  // The early turns were compacted away; the summary and every later turn must be carried.
  const resumed = (label, task) => h.expectRequest(label, body => lastUserMentions(body, task, h) && mentions(COMPACTION.summary)(body) && mentions(TASKS.approvals)(body), { content: 'Done so far: report v1 and v2.', usage })
  const cancelStream = [stall('cancelStream turn', TASKS.cancelStream, STALL_TEXT.cancel)]
  const cancelTool = [slow('cancelTool turn', TASKS.cancelTool)]
  const streamKill = [stall('streamKill turn', TASKS.streamKill, STALL_TEXT.kill)]
  const resumeAfterStream = [resumed('resumed turn after the stream kill', TASKS.resumeAfterStream)]
  const toolKill = [slow('toolKill turn', TASKS.toolKill)]
  const resumeAfterTool = [resumed('resumed turn after the tool kill', TASKS.resumeAfterTool)]
  // One request per turn; the second turn must never reach the server (perProject cap).
  const budget = [
    h.expectRequest('budget turn 1', body => lastUserMentions(body, TASKS.budget, h), { content: 'There are 2 orders.', usage }),
    h.expectRequest('nothing (the cap must stop the second turn)', () => false, { content: 'unreachable', usage }),
  ]
  return { first, feedback, goal, pause, compactFail, compact, approvals, cancelStream, cancelTool, streamKill, resumeAfterStream, toolKill, resumeAfterTool, budget }
}
