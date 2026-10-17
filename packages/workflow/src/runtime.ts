/**
 * Running one workflow (`data-formats.md` §工作流, `permissions.md`
 * §代码执行进程): the script runs in a PTC program process
 * (`@nexgent/ptc`); `agent()` and `phase()` are host functions answered
 * here (`phase()` through the `workflowPhase` binding, so a call need not be
 * awaited), `parallel()`, `pipeline()` and `log()` are helpers defined in
 * the program on top of them. The host enforces the bounds, so a script cannot
 * get around them: at most `maxConcurrentMembers` members run at once
 * (further `agent()` calls wait), at most `maxMembersPerTask` members start
 * per workflow (the next `agent()` call fails).
 *
 * Records go to the parent session through `appendRecord`, in order:
 * `workflow.start`; per member `subagent.start` (after the child session
 * exists) and `subagent.end`; `workflow.phase` per `phase()`; and
 * `workflow.end` after every member has settled. A member that does not
 * complete rejects its `agent()` call; the script decides what that means
 * (ADR 0017 decision 5, audit D3): caught, the workflow can still end
 * `completed` (the member's own records say it failed); left uncaught, the
 * workflow ends `failed` with that member's error. Members that completed
 * keep their records and deliverables. Cancelling `signal` cancels the
 * program and every running member and ends the workflow `cancelled`.
 */
import { randomUUID } from 'node:crypto'
import {
  COLLABORATION_LIMITS,
  MEMBER_NAME_PATTERN,
  NexgentError,
  assertToolRestriction,
  toErrorInfo,
  type ErrorInfo,
  type JsonValue,
  type MemberResult,
  type SessionRecordInput,
  type ToolRecordInput,
  type ToolRestriction,
  type WorkflowStatus,
} from '@nexgent/kernel'
import { runProgram, type HostFunction, type ProgramResult, type RunProgramOptions } from '@nexgent/ptc'
import type { MemberRun } from '@nexgent/subagent'
import type { WorkflowMemberRunner } from './runner.js'

/** Deadline of a workflow script (its members do the waiting); cancellation ends it sooner. */
export const WORKFLOW_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** Characters of a member's task copied into `subagent.start.task`. */
export const RECORDED_TASK_CHARS = 500

/** Longest `phase()` title. */
export const MAX_PHASE_CHARS = 200

/** Options `agent(prompt, options)` accepts. */
export const AGENT_OPTION_KEYS = ['name', 'preset', 'materialIds', 'files', 'tools', 'model', 'maxRequests'] as const

/**
 * Helpers defined in the program on top of the host functions. `parallel`
 * and `pipeline` wait for every branch before rethrowing the first failure,
 * so members already running finish and keep their results.
 */
export const WORKFLOW_PRELUDE = String.raw`
const MAX_PHASE = ${MAX_PHASE_CHARS}
const settle = async (label, promises) => {
  const settled = await Promise.allSettled(promises)
  const failed = settled.find(item => item.status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return settled.map(item => item.value)
}
const parallel = async tasks => {
  if (!Array.isArray(tasks)) throw new TypeError('parallel() takes an array of functions')
  tasks.forEach((task, index) => {
    if (typeof task !== 'function') throw new TypeError('parallel() item ' + index + ' is not a function')
  })
  return settle('parallel', tasks.map(task => (async () => task())()))
}
const pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new TypeError('pipeline() takes an array of items, then stage functions')
  if (stages.length === 0) throw new TypeError('pipeline() needs at least one stage function')
  stages.forEach((stage, index) => {
    if (typeof stage !== 'function') throw new TypeError('pipeline() stage ' + index + ' is not a function')
  })
  return settle('pipeline', items.map(async (item, index) => {
    let value = item
    for (const stage of stages) value = await stage(value, item, index)
    return value
  }))
}
const log = (...values) => console.log(...values)
const phase = title => {
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_PHASE) throw new TypeError('phase() takes a title of 1 to ' + MAX_PHASE + ' characters')
  workflowPhase(title).catch(() => {})
}
return { parallel, pipeline, log, phase }
`

/** One member as the workflow saw it. */
export interface WorkflowMemberSummary {
  readonly name: string
  readonly childSessionId: string
  readonly status: MemberResult['status']
  readonly text: string
  readonly files: readonly string[]
}

/** Options of {@link runWorkflow}. */
export interface RunWorkflowOptions {
  /** Script body (for a graph, the compiled script). */
  readonly script: string
  readonly kind: 'script' | 'graph'
  /** Graph runs: the saved graph's version. */
  readonly architecture?: string
  readonly title?: string
  readonly args?: JsonValue
  readonly runner: WorkflowMemberRunner
  /** The calling (parent, root) session. */
  readonly parentSessionId: string
  readonly turn: number
  readonly toolCallId: string
  /** Appends a record to the parent session (the tool context's `appendRecord`). */
  readonly appendRecord: (record: ToolRecordInput) => Promise<void>
  /** Project root: the program's cwd. */
  readonly cwd: string
  readonly signal: AbortSignal
  readonly maxConcurrentMembers?: number
  readonly maxMembers?: number
  readonly timeoutMs?: number
  /** Host process settings passed to `@nexgent/ptc`. */
  readonly ptc?: Pick<RunProgramOptions, 'nodePath' | 'permission' | 'windowsJob' | 'pwshPath'>
  /** Fixed id (tests); default a new UUID v4. */
  readonly workflowId?: string
}

/** The outcome of {@link runWorkflow}. */
export interface WorkflowRunResult {
  readonly workflowId: string
  readonly status: WorkflowStatus
  readonly members: readonly WorkflowMemberSummary[]
  /** The script's return value (`completed` only). */
  readonly value?: JsonValue
  readonly output: string
  readonly outputTruncated: boolean
  readonly error?: ErrorInfo
}

/** A counting semaphore whose waiters give up when their signal fires. */
class Slots {
  private active = 0
  private readonly waiting: { resolve: () => void; reject: (error: unknown) => void }[] = []

  constructor(private readonly size: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active < this.size) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        reject,
      }
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
    return () => this.release()
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next !== undefined) next.resolve()
    else this.active -= 1
  }
}

function stringList(value: JsonValue | undefined, what: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) throw new NexgentError('tool/invalid-input', `agent() ${what} must be an array of non-empty strings`)
  return value as string[]
}

function optionalText(value: JsonValue | undefined, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new NexgentError('tool/invalid-input', `agent() ${what} must be a non-empty string`)
  return value
}

/** Run one workflow to its end and record it. Never rejects for script or member failures; a script error, or a member failure the script does not catch, ends the workflow `failed`. */
export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const workflowId = options.workflowId ?? randomUUID()
  const maxConcurrent = options.maxConcurrentMembers ?? COLLABORATION_LIMITS.maxConcurrentMembers
  const maxMembers = options.maxMembers ?? COLLABORATION_LIMITS.maxMembersPerTask
  const slots = new Slots(maxConcurrent)
  const usedNames = new Set<string>()
  const members: WorkflowMemberSummary[] = []
  const failures: ErrorInfo[] = []
  // Failures of members that settled after the script ended: the script never saw them, so they end the workflow failed.
  const unseen: ErrorInfo[] = []
  let programEnded = false
  const fail = (info: ErrorInfo) => (programEnded ? unseen : failures).push(info)
  const inflight = new Set<Promise<unknown>>()
  let requested = 0
  let started = 0

  // Records are appended one at a time, in the order they are issued.
  let chain: Promise<void> = Promise.resolve()
  let recordError: unknown
  const record = (input: ToolRecordInput): Promise<void> => {
    const next = chain.then(() => options.appendRecord(input))
    chain = next.catch(error => {
      recordError ??= error
    })
    return next
  }

  const uniqueName = (requestedName: string | undefined): string => {
    const base = requestedName ?? `member-${requested}`
    if (!MEMBER_NAME_PATTERN.test(base)) {
      throw new NexgentError('tool/invalid-input', `agent() name ${JSON.stringify(base)} must be lowercase letters, digits and dashes, starting with a letter (at most 32 characters)`)
    }
    let name = base
    for (let k = 2; usedNames.has(name); k++) name = `${base.slice(0, 31 - String(k).length)}-${k}`
    usedNames.add(name)
    return name
  }

  const runMember = async (args: readonly JsonValue[], callSignal: AbortSignal): Promise<JsonValue> => {
    const [prompt, rawOptions] = args
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new NexgentError('tool/invalid-input', 'agent() needs a prompt string')
    const opts = rawOptions === undefined || rawOptions === null ? {} : rawOptions
    if (typeof opts !== 'object' || Array.isArray(opts)) throw new NexgentError('tool/invalid-input', 'agent() options must be an object')
    const extra = Object.keys(opts).filter(key => !(AGENT_OPTION_KEYS as readonly string[]).includes(key))
    if (extra.length > 0) throw new NexgentError('tool/invalid-input', `agent() does not take ${extra.join(', ')}; options are ${AGENT_OPTION_KEYS.join(', ')}`)
    const record_ = opts as Record<string, JsonValue>
    let tools: ToolRestriction | undefined
    if (record_.tools !== undefined && record_.tools !== null) {
      try {
        assertToolRestriction(record_.tools)
      } catch (error) {
        throw new NexgentError('tool/invalid-input', `agent() tools: ${(error as Error).message}`)
      }
      tools = record_.tools
    }
    const preset = optionalText(record_.preset, 'preset')
    const model = optionalText(record_.model, 'model')
    const materialIds = stringList(record_.materialIds, 'materialIds')
    const files = stringList(record_.files, 'files')
    const maxRequests = record_.maxRequests ?? undefined
    if (maxRequests !== undefined && (typeof maxRequests !== 'number' || !Number.isInteger(maxRequests) || maxRequests < 1)) {
      throw new NexgentError('tool/invalid-input', 'agent() maxRequests must be a positive integer')
    }
    if (requested >= maxMembers) {
      throw new NexgentError('tool/denied', `a workflow starts at most ${maxMembers} members; this is agent() call ${requested + 1}`)
    }
    requested += 1
    const name = uniqueName(optionalText(record_.name, 'name'))

    const signal = AbortSignal.any([options.signal, callSignal])
    const release = await slots.acquire(signal)
    try {
      let run: MemberRun
      let recorded = false
      try {
        run = await options.runner({
          parentSessionId: options.parentSessionId,
          projectRoot: options.cwd,
          name,
          workflowId,
          task: prompt,
          ...(preset === undefined ? {} : { preset }),
          ...(tools === undefined ? {} : { tools }),
          ...(model === undefined ? {} : { model }),
          ...(materialIds === undefined ? {} : { materialIds }),
          ...(files === undefined ? {} : { files }),
          ...(maxRequests === undefined ? {} : { maxRequests }),
          signal,
          turn: options.turn,
          toolCallId: options.toolCallId,
          record: input => {
            if (input.type === 'subagent.start') {
              recorded = true
              started += 1
            }
            return record(input)
          },
        })
      } catch (error) {
        const info = toErrorInfo(error)
        const message = `member ${name} ${recorded ? 'failed' : 'could not start'}: ${info.message}`
        fail({ ...info, message })
        throw new NexgentError(info.code, message)
      }
      let result = run.result
      if (result.status !== 'completed' && result.error === undefined) {
        result = { ...result, error: { name: 'NexgentError', code: 'tool/failed', message: `the member ended ${result.status}` } }
      }
      members.push({
        name,
        childSessionId: run.childSessionId,
        status: result.status,
        text: result.text,
        files: result.deliverables.flatMap(version => version.files.map(file => file.path)),
      })
      if (result.status !== 'completed') {
        const message = `member ${name} ${result.status}: ${result.error?.message ?? 'no detail'}`
        fail({ ...(result.error ?? { name: 'NexgentError', code: 'tool/failed', message }), message })
        throw new NexgentError('tool/failed', message)
      }
      return JSON.parse(JSON.stringify({ name, ...result })) as JsonValue
    } finally {
      release()
    }
  }

  const agent: HostFunction = {
    name: 'agent',
    call: (args, context) => {
      const run = runMember(args, context.signal)
      inflight.add(run)
      void run.finally(() => inflight.delete(run)).catch(() => {})
      return run
    },
  }
  const phase: HostFunction = {
    name: 'workflowPhase',
    call: async ([title]) => {
      if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_PHASE_CHARS) {
        throw new NexgentError('tool/invalid-input', `phase() takes a title of 1 to ${MAX_PHASE_CHARS} characters`)
      }
      await record({ type: 'workflow.phase', turn: options.turn, workflowId, phase: title })
      return null
    },
  }

  await record({
    type: 'workflow.start',
    turn: options.turn,
    toolCallId: options.toolCallId,
    workflowId,
    kind: options.kind,
    ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })

  let program: ProgramResult
  try {
    program = await runProgram({
      ...options.ptc,
      code: options.script,
      cwd: options.cwd,
      functions: [agent, phase],
      globals: { args: options.args ?? null },
      prelude: WORKFLOW_PRELUDE,
      timeoutMs: options.timeoutMs ?? WORKFLOW_TIMEOUT_MS,
      unboundedTimeout: true,
      signal: options.signal,
    })
  } catch (error) {
    program = { status: 'crashed', output: '', outputTruncated: false, error: { name: 'Error', message: toErrorInfo(error).message }, calls: 0, durationMs: 0 }
  }
  programEnded = true
  // Members still running when the program ended were cancelled with it; wait for their records.
  while (inflight.size > 0) await Promise.allSettled([...inflight])
  await chain

  let status: WorkflowStatus
  let error: ErrorInfo | undefined
  if (options.signal.aborted || program.status === 'cancelled') {
    status = 'cancelled'
    error = { name: 'NexgentError', code: 'tool/aborted', message: 'the workflow was cancelled' }
  } else if (program.status !== 'completed') {
    status = 'failed'
    // An uncaught member failure ends the script with that member's error; report the member's own.
    const uncaught = failures.find(failure => program.error?.message.includes(failure.message) === true)
    error = uncaught ?? {
      name: program.error?.name ?? 'Error',
      code: program.status === 'timeout' ? 'tool/timeout' : 'tool/failed',
      message: `the workflow script ${program.status === 'failed' ? 'failed' : program.status === 'timeout' ? 'timed out' : 'crashed'}: ${program.error?.message ?? 'no detail'}`,
    }
  } else if (unseen.length > 0) {
    status = 'failed'
    error = unseen[0]
  } else {
    status = 'completed'
  }
  if (recordError !== undefined && status === 'completed') {
    status = 'failed'
    error = toErrorInfo(recordError)
  }
  await record({ type: 'workflow.end', turn: options.turn, workflowId, status, members: started, ...(error === undefined ? {} : { error }) }).catch(() => {})
  return {
    workflowId,
    status,
    members,
    ...(status === 'completed' && program.value !== undefined ? { value: program.value } : {}),
    output: program.output,
    outputTruncated: program.outputTruncated,
    ...(error === undefined ? {} : { error }),
  }
}
