/**
 * The CLI scenario of the PowerShell launcher smoke (ps1-smoke.mjs) as data:
 * write a file, a turn that stalls, the continuation. Unit-tested in
 * `apps/cli/tests/accept-common.spec.ts`. (It was the step-1 acceptance
 * scenario; `scripts/accept-step1.mjs` was retired on 2026-10-11.)
 */

/** WIRE: the workspace package's file-write tool name and argument shape. */
export const WRITE_TOOL = 'write_file'

/** Fixed test key; the scripted server never checks it. */
export const SCRIPTED_API_KEY = 'nexgent-accept-scripted-key'

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

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

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
