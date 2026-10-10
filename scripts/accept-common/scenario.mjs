/**
 * The step-1 acceptance scenario as data plus pure checks, so the parts that
 * do not need a running runtime can be unit-tested
 * (`apps/cli/tests/accept-common.spec.ts`).
 */

/** WIRE: the workspace package's file-write tool name and argument shape. */
export const WRITE_TOOL = 'write_file'

/** Fixed test key; the scripted server never checks it. */
export const SCRIPTED_API_KEY = 'nexgent-accept-step1-scripted-key'

/** The `--json` error code `nexgent` prints while its runtime is not wired. */
export const RUNTIME_NOT_WIRED_CODE = 'cli/runtime-not-wired'

/** Files the scenario writes and their contents. */
export const FILES = {
  first: { path: 'hello.txt', content: 'Hello from Nexgent step 1\n' },
  resumed: { path: 'after-resume.txt', content: 'Written after resume\n' },
}

/** The three tasks: write a file, a long turn that gets killed, the continuation. */
export const TASKS = {
  write: `Create ${FILES.first.path} with one line: Hello from Nexgent step 1`,
  long: 'Write a long design note about the project (this turn is killed mid-stream)',
  resume: `Continue: also create ${FILES.resumed.path}`,
}

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, reasoningTokens: 0 }

/**
 * Script for the scripted model server, one entry per model request:
 * run (tool call, answer), resume #1 (stalls after one chunk: killed),
 * resume #2 (tool call, answer). Format: test-support `ScriptedTurn`.
 */
export function buildScript() {
  return [
    { toolCalls: [{ name: WRITE_TOOL, arguments: FILES.first }], usage },
    { content: [`Created ${FILES.first.path}.`], usage },
    // message_start, content_block_start, then the one text_delta reaches the client before the stall.
    { content: ['Working on the long note'], fault: { kind: 'timeout', afterChunks: 3 } },
    { toolCalls: [{ name: WRITE_TOOL, arguments: FILES.resumed }], usage },
    { content: [`Created ${FILES.resumed.path}.`], usage },
  ]
}

/** Parse `--json` stdout into event objects; non-JSON lines are skipped. */
export function parseJsonLines(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') events.push(value)
    } catch {
      // not an event line
    }
  }
  return events
}

/** The session id announced by the opening `session` event. */
export function sessionIdFrom(events) {
  const open = events.find(event => event.type === 'session')
  return typeof open?.sessionId === 'string' ? open.sessionId : undefined
}

/** Whether `nexgent` reported that its runtime is not wired (exit 2 + error line). */
export function isRuntimeNotWired(exit, events) {
  return exit.code === 2 && events.some(event => event.type === 'error' && event.error?.code === RUNTIME_NOT_WIRED_CODE)
}

/** Map turn number → `turn.end` reason kind, from session records. */
export function turnEndKinds(records) {
  const kinds = new Map()
  for (const record of records) if (record.type === 'turn.end') kinds.set(record.turn, record.reason?.kind)
  return kinds
}

/** Whether `seq` runs 1, 2, 3, … without gaps. */
export function seqContiguous(records) {
  return records.every((record, index) => record.seq === index + 1)
}

/** Turn numbers opened but never closed. */
export function openTurns(records) {
  const open = new Set()
  for (const record of records) {
    if (record.type === 'turn.start') open.add(record.turn)
    if (record.type === 'turn.end') open.delete(record.turn)
  }
  return [...open]
}

/** `task.outcome` records of one session, in order. */
export function taskOutcomes(ledger, sessionId) {
  return ledger.filter(record => record.type === 'task.outcome' && record.sessionId === sessionId)
}

/** Request ids with a start but no end, and ends without a start. */
export function unpairedRequests(ledger) {
  const starts = new Set()
  const ends = new Set()
  for (const record of ledger) {
    if (record.type === 'llm.request.start') starts.add(record.requestId)
    if (record.type === 'llm.request.end') ends.add(record.requestId)
  }
  return {
    withoutEnd: [...starts].filter(id => !ends.has(id)),
    withoutStart: [...ends].filter(id => !starts.has(id)),
  }
}

/** Visible text of one Messages API `content` value: a string, or the `text` blocks of an array. */
export function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

/** Whether a Messages API request body carries a user message containing `text` (history survived resume). */
export function requestMentions(body, text) {
  return (body?.messages ?? []).some(message => message.role === 'user' && messageText(message.content).includes(text))
}
