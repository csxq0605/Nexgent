/**
 * Coordinator step two: threads. The project's coordinator conversation
 * hands long, separable pieces of work to threads: root sessions that run in
 * the background, each in its own copy of the project (merged back at the
 * end of each of its turns), that the user can open and talk to like any
 * conversation. A thread that ends a turn it was given by the coordinator
 * wakes the coordinator with a short note (`user.message.source: thread`).
 *
 * The host records each thread turn the coordinator started as a member run
 * in the coordinator conversation (`subagent.start` when it starts,
 * `subagent.end` when it ends, `executionForm: thread`), so the
 * organization profile measures threads like members (cost, time, failures,
 * waiting, wasted work) and the organization library keeps the thread
 * layout of similar tasks.
 *
 * Types and tool specs only; the host (`@nexgent/sdk`) implements
 * {@link ThreadHost} as `ctx.threads`, the `@nexgent/threads` plugin the tools.
 */
import type { JsonSchema } from './json.js'
import type { LLMUsage } from './llm.js'
import type { Step2ToolSpec } from './step2-tools.js'

/** Who started a thread: written into the thread's `session.start.thread`. */
export interface ThreadOrigin {
  /** The coordinator conversation the thread belongs to. */
  readonly coordinatorSessionId: string
  /** Short name the coordinator gave it (shown on its card and in the sidebar). */
  readonly title: string
}

/**
 * Where a thread stands: `running` (a turn is going on), `waiting` (its last
 * turn ended with a question or blocker for the user or the coordinator),
 * `done` (its last turn completed), `stopped` (cancelled, a cost cap, or the
 * process died) or `failed`.
 */
export type ThreadStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'failed'

/** Every thread status. */
export const THREAD_STATUSES: readonly ThreadStatus[] = ['running', 'waiting', 'done', 'stopped', 'failed']

/** A thread as the coordinator and the interface see it. */
export interface ThreadInfo {
  /** The thread's session id (its handle in the tools). */
  readonly threadId: string
  readonly title: string
  readonly coordinatorSessionId: string
  readonly status: ThreadStatus
  /** Turns the thread has run. */
  readonly turns: number
  readonly createdAt: string
  /** `ts` of its last record. */
  readonly updatedAt: string
  /** The blocker or question its last report named, when `waiting`. */
  readonly blocker?: string
  /** Coordinator step three: a tool call in the thread waits for the user to allow it. */
  readonly needsApproval?: true
}

/** `read_thread`: a thread with its last reply and what its last turn changed. */
export interface ThreadView extends ThreadInfo {
  /** The last reply, cut to {@link THREAD_LIMITS.replyChars}. */
  readonly reply: string
  /** Characters of the reply that were cut. */
  readonly cut?: number
  /** Project files its last turn brought into the project. */
  readonly applied: readonly string[]
  /** Files both it and the project changed; the project kept its version, the thread's is at `copy`. */
  readonly conflicts: readonly { readonly path: string; readonly copy?: string }[]
  readonly usage?: LLMUsage
}

/** Limits of the thread tools. */
export const THREAD_LIMITS = {
  /** Threads of one coordinator running at the same time. */
  maxRunning: 3,
  /** Threads one coordinator conversation can have. */
  maxThreads: 12,
  /** Characters of a thread's reply `read_thread` shows. */
  replyChars: 20_000,
  /** Characters of a thread's reply the wake note carries. */
  wakeChars: 1_500,
  /** Title length. */
  titleChars: 60,
  /** Coordinator step three: characters of the project notes (`update_project_notes`). */
  notesChars: 8_000,
} as const

/** Where in the coordinator conversation a thread run is started from (its `subagent.start` goes there). */
export interface ThreadCaller {
  readonly coordinatorSessionId: string
  /** The coordinator's running turn. */
  readonly turn: number
  /** The tool call starting the run. */
  readonly toolCallId?: string
}

/** Input of {@link ThreadHost.start}. */
export interface ThreadStartInput extends ThreadCaller {
  readonly title: string
  /** The thread's first message: its part, inputs, what to produce and where. */
  readonly task: string
  readonly materialIds?: readonly string[]
}

/**
 * `ctx.threads`, implemented by the host that runs conversations (the SDK).
 * Every method names the coordinator conversation asking; a thread of
 * another coordinator is `session/not-found`.
 */
export interface ThreadHost {
  /** Create a thread and start its first turn in the background. Refused (`tool/denied`) over {@link THREAD_LIMITS}. */
  start(input: ThreadStartInput): Promise<ThreadInfo>
  /** Send a message: it joins the thread's running turn, or starts its next turn in the background. */
  message(input: ThreadCaller & { readonly threadId: string; readonly text: string }): Promise<ThreadInfo>
  read(input: { readonly coordinatorSessionId: string; readonly threadId: string }): Promise<ThreadView>
  list(input: { readonly coordinatorSessionId: string }): Promise<readonly ThreadInfo[]>
}

const threadId: JsonSchema = { type: 'string', minLength: 1, description: 'The thread id start_thread or list_threads gave.' }

/** `start_thread`: hand a long, separable piece of work to a thread running in the background. */
export const START_THREAD_TOOL: Step2ToolSpec = {
  name: 'start_thread',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'task'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: THREAD_LIMITS.titleChars, description: 'A few words naming the piece of work.' },
      task: { type: 'string', minLength: 1, description: 'Everything the thread needs: its part, the inputs, what to produce and where, and what not to touch.' },
      materialIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  },
}

/** `message_thread`: tell a thread something (a correction, an answer, the next step). */
export const MESSAGE_THREAD_TOOL: Step2ToolSpec = {
  name: 'message_thread',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['thread', 'text'],
    properties: { thread: threadId, text: { type: 'string', minLength: 1 } },
  },
}

/** `read_thread`: a thread's status, last reply and the files its last turn changed. */
export const READ_THREAD_TOOL: Step2ToolSpec = {
  name: 'read_thread',
  effects: ['read'],
  approval: 'never',
  concurrent: true,
  inputSchema: { type: 'object', additionalProperties: false, required: ['thread'], properties: { thread: threadId } },
}

/** `list_threads`: every thread of this conversation with its status. */
export const LIST_THREADS_TOOL: Step2ToolSpec = {
  name: 'list_threads',
  effects: ['read'],
  approval: 'never',
  concurrent: true,
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}

/** The thread tools, in the order above. Members and threads do not see them. */
export const THREAD_TOOLS: readonly Step2ToolSpec[] = [START_THREAD_TOOL, MESSAGE_THREAD_TOOL, READ_THREAD_TOOL, LIST_THREADS_TOOL]

/** Names of {@link THREAD_TOOLS}. */
export const THREAD_TOOL_NAMES = ['start_thread', 'message_thread', 'read_thread', 'list_threads'] as const

/** Pure: the note a thread's ended turn wakes its coordinator with. */
export function threadWakeNote(input: { readonly title: string; readonly threadId: string; readonly status: ThreadStatus; readonly reply: string }): string {
  const what = input.status === 'done' ? 'finished its turn' : input.status === 'waiting' ? 'stopped with a question or blocker' : input.status === 'failed' ? 'failed' : 'was stopped'
  const reply = input.reply.length > THREAD_LIMITS.wakeChars ? `${input.reply.slice(0, THREAD_LIMITS.wakeChars)}\n[… cut; read_thread shows the whole reply]` : input.reply
  return `Thread "${input.title}" (${input.threadId}) ${what}. Its last reply:\n${reply.trim() === '' ? '(empty)' : reply}`
}

/**
 * Coordinator step three: `update_project_notes`, the coordinator
 * conversation's notes of the project (long-term goals, rules, decisions,
 * pitfalls). The whole text is replaced; the host keeps it in
 * `<dataDir>/coordinator-notes.md` and shows it to the coordinator at the
 * start of every turn. Only the coordinator conversation sees the tool.
 */
export const UPDATE_PROJECT_NOTES_TOOL: Step2ToolSpec = {
  name: 'update_project_notes',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['notes'],
    properties: {
      notes: { type: 'string', maxLength: THREAD_LIMITS.notesChars, description: 'The whole new text of the project notes (it replaces the old text).' },
    },
  },
}

/** Tools only the project's coordinator conversation sees. */
export const COORDINATOR_TOOL_NAMES = ['update_project_notes'] as const
