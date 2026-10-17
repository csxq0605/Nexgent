/**
 * The team tools (`agent-hooks.md` §步骤 3 工具). Names, input schemas,
 * effects (`read`) and approval (`never`) are frozen in the contract
 * (`SPAWN_TEAMMATE_TOOL` …); a teammate's own tool calls are checked under
 * its own rules one by one.
 *
 * The Lead's six tools are registered globally; a teammate gets its own
 * `send_message`, `team_task_list` and `team_task_update` in its agent scope
 * (they shadow the global ones), and `wait_for_message` (rework K4). Members never start teammates: the kernel
 * hides `spawn_teammate` and `wait_teammates` from them, and every Lead tool
 * refuses a call from a member.
 */
import {
  BUILTIN_PRESET_NAMES,
  NexgentError,
  SEND_MESSAGE_TOOL,
  SPAWN_TEAMMATE_TOOL,
  TEAM_LEAD_NAME,
  TEAM_TASK_CREATE_TOOL,
  TEAM_TASK_LIST_TOOL,
  TEAM_TASK_UPDATE_TOOL,
  WAIT_FOR_MESSAGE_TOOL,
  WAIT_TEAMMATES_TOOL,
  memberReplyShare,
  type JsonValue,
  type KernelToolContext,
  type SpawnTeammateToolInput,
  type Step3ToolSpec,
  type TaskingService,
  type TeamTaskStatus,
  type Tool,
  type ToolContext,
  type ToolOutput,
} from '@nexgent/kernel'
import { DEFAULT_PRESET_NAME, sessionPresetRegistry, type CapabilityPresetLookup } from '@nexgent/preset'
import { assertFilesExist, normalizeMemberFiles, renderMemberResult } from '@nexgent/subagent'
import { renderBoard } from './state.js'
import { renderTeammatePrompt, type LeadCall, type Team } from './team.js'

/** How a Lead tool finds (or starts) the team of the calling session. */
export interface LeadToolOptions {
  readonly team: (leadSessionId: string) => Promise<Team>
  readonly tasking?: () => TaskingService | undefined
  /** `ctx.capabilities`, when loaded: presets of the Lead session's capability version and the ones it tried. */
  readonly capabilities?: CapabilityPresetLookup
}

const DESCRIPTIONS = {
  spawn_teammate: 'Add a named teammate (a separate agent session) and give it its first task. It starts working in the background at once, '
    + 'in the same project directory, with your sandbox mode or a narrower one, and cannot start teammates or delegate. '
    + 'Teammates only work while your turn lasts: collect their results with wait_teammates before you finish. '
    + `At most 4 run at once. Presets: ${BUILTIN_PRESET_NAMES.join(', ')} (default ${DEFAULT_PRESET_NAME}), or .nexgent/presets/<name>.json; `
    + 'persona replaces the preset\'s persona but never widens its tools or sandbox.',
  send_message: 'Send a message to a teammate by name, or to "lead". It is delivered once: before a working teammate\'s next step, '
    + 'otherwise at the start of the recipient\'s next turn; an idle teammate is woken by it.',
  wait_teammates: 'Wait until the named teammates (default: every active one) have stopped working, then return each one\'s last result '
    + '(status, deliverables, final reply) and the messages sent to you. By default it also returns as soon as a teammate sends you a message, '
    + 'so you can answer it while the others keep working (until: "idle" waits for all of them); call it again to keep waiting.',
  wait_for_message: 'Wait, without spending model requests, until a message for you arrives, one of the named teammates finishes its current run, '
    + 'or the timeout passes (default 120 seconds). Use it instead of sleeping when you need another teammate\'s answer or result.',
  team_task_create: 'Add a task to the shared task board. dependsOn lists task ids that must be completed before this one can start.',
  team_task_list: 'Show the shared task board and the team.',
  team_task_update: 'Change a task: claim it (status in_progress; fails while a task it depends on is not completed), '
    + 'complete it with a one-line result, cancel it, or set its owner. Completed and cancelled tasks are final.',
} as const

function definition(spec: Step3ToolSpec): Tool['definition'] {
  return {
    name: spec.name,
    description: DESCRIPTIONS[spec.name as keyof typeof DESCRIPTIONS],
    inputSchema: spec.inputSchema,
    effects: [...spec.effects],
    approval: spec.approval,
  }
}

function meta(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function leadCall(context: ToolContext): LeadCall {
  const append = (context as Partial<KernelToolContext>).appendRecord
  if (append === undefined) throw new NexgentError('internal', 'team tools need a host that records tool records')
  return { turn: context.turn, callId: context.callId, signal: context.signal, append }
}

function onlyLead(context: ToolContext, tool: string): void {
  if (context.member !== undefined) {
    throw new NexgentError('tool/denied', context.member.executionForm === 'team'
      ? `${tool} is for the lead only`
      : `${tool} belongs to team work; a ${context.member.executionForm} member is not on a team`)
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NexgentError('tool/invalid-input', `"${field}" must be a non-empty string`)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field).trim()
}

function stringList(value: unknown, field: string, max = 50): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new NexgentError('tool/invalid-input', `"${field}" must be an array of at most ${max} non-empty strings`)
  }
  return [...new Set(value.map(item => (item as string).trim()))]
}

const STATUSES: readonly TeamTaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

function taskUpdateInput(raw: unknown): { id: string; status?: TeamTaskStatus; owner?: string; result?: string } {
  const args = (raw ?? {}) as Record<string, unknown>
  const id = text(args.id, 'id').trim()
  if (args.status !== undefined && !STATUSES.includes(args.status as TeamTaskStatus)) {
    throw new NexgentError('tool/invalid-input', `"status" must be one of ${STATUSES.join(', ')}`)
  }
  const owner = optionalText(args.owner, 'owner')
  const result = args.result === undefined ? undefined : String(args.result)
  return {
    id,
    ...(args.status === undefined ? {} : { status: args.status as TeamTaskStatus }),
    ...(owner === undefined ? {} : { owner }),
    ...(result === undefined ? {} : { result }),
  }
}

async function checkMaterials(tasking: TaskingService | undefined, ids: readonly string[]): Promise<void> {
  if (tasking === undefined || ids.length === 0) return
  const unknown: string[] = []
  for (const id of ids) {
    const material = await tasking.materials.get(id)
    if (material === undefined || material.status !== 'active') unknown.push(id)
  }
  if (unknown.length > 0) {
    throw new NexgentError('tool/invalid-input', `unknown or removed material ids: ${unknown.join(', ')}`, { details: { materialIds: unknown } })
  }
}

function boardOutput(team: Team): ToolOutput {
  return {
    content: renderBoard(team.state, team.running()),
    meta: meta({ members: [...team.state.members.values()], tasks: [...team.state.tasks.values()] }),
  }
}

/** The Lead's six tools (registered globally). */
export function leadTools(options: LeadToolOptions): Tool[] {
  const spawn: Tool = {
    definition: definition(SPAWN_TEAMMATE_TOOL),
    handler: async (raw, context) => {
      onlyLead(context, 'spawn_teammate')
      const call = leadCall(context)
      const args = (raw ?? {}) as Record<string, unknown>
      const input: SpawnTeammateToolInput = { name: text(args.name, 'name'), task: text(args.task, 'task').trim() }
      const presetName = optionalText(args.preset, 'preset')
      const persona = optionalText(args.persona, 'persona')
      const materialIds = stringList(args.materialIds, 'materialIds')
      const root = context.workspace.root
      const files = normalizeMemberFiles(root, stringList(args.files, 'files'))
      await assertFilesExist(root, files)
      await checkMaterials(options.tasking?.(), materialIds)
      const preset = await (await sessionPresetRegistry(root, context.sessionId, options.capabilities)).resolve(presetName ?? DEFAULT_PRESET_NAME)
      const team = await options.team(context.sessionId)
      const others = [...team.state.members.values()].filter(member => member.status !== 'stopped' && member.name !== input.name).map(member => member.name)
      const agent = await team.spawn(call, {
        name: input.name,
        preset,
        ...(persona === undefined ? {} : { persona }),
        prompt: renderTeammatePrompt({ name: input.name, task: input.task, files, team: others }),
        task: input.task,
        materialIds,
      })
      return {
        content: `Teammate ${input.name} started (session ${agent.sessionId}) and is working in the background. `
          + 'It stops when your turn ends; call wait_teammates to collect its result before you finish.',
        meta: meta({ name: input.name, childSessionId: agent.sessionId, preset: preset.name }),
      }
    },
  }

  const send: Tool = {
    definition: definition(SEND_MESSAGE_TOOL),
    handler: async (raw, context) => {
      onlyLead(context, 'send_message')
      const args = (raw ?? {}) as Record<string, unknown>
      const team = await options.team(context.sessionId)
      const message = await team.sendFromLead(leadCall(context), text(args.to, 'to').trim(), text(args.text, 'text'))
      return { content: `Message ${message.id} queued for ${message.to}; it is delivered before its next step, or at the start of its next turn when it is not working.`, meta: meta({ id: message.id, to: message.to }) }
    },
  }

  const wait: Tool = {
    definition: definition(WAIT_TEAMMATES_TOOL),
    handler: async (raw, context) => {
      onlyLead(context, 'wait_teammates')
      const args = (raw ?? {}) as Record<string, unknown>
      const names = args.names === undefined ? undefined : stringList(args.names, 'names', 16)
      if (args.until !== undefined && args.until !== 'mail-or-idle' && args.until !== 'idle') throw new NexgentError('tool/invalid-input', '"until" must be mail-or-idle or idle')
      const team = await options.team(context.sessionId)
      const { targets, mail } = await team.wait(leadCall(context), names, (args.until as 'mail-or-idle' | 'idle' | undefined) ?? 'mail-or-idle')
      const lines: string[] = []
      const members = []
      const running = team.running()
      const share = memberReplyShare(targets.length)
      if (targets.length === 0) lines.push('No teammate was working.')
      for (const name of targets) {
        const member = team.state.members.get(name)!
        const last = team.lastRun(name)
        lines.push(`## ${name} (${running.has(name) ? 'still working; call wait_teammates again to wait for it' : member.status})`)
        lines.push(last === undefined ? 'No run yet.' : renderMemberResult({ name, childSessionId: last.childSessionId, result: last.result }, share))
        members.push({ name, status: member.status, sessionId: member.sessionId, ...(last === undefined ? {} : { childTurn: last.childTurn, result: last.result }) })
      }
      if (mail.length > 0) {
        lines.push('', `## Messages for ${TEAM_LEAD_NAME}`)
        for (const message of mail) lines.push(`<team-message id="${message.id}" from="${message.from}">\n${message.text}\n</team-message>`)
      }
      lines.push('', renderBoard(team.state, team.running()))
      const failed = members.some(member => member.result !== undefined && member.result.status !== 'completed')
      return { content: lines.join('\n'), isError: failed, meta: meta({ members, mail: mail.map(message => message.id) }) }
    },
  }

  const create: Tool = {
    definition: definition(TEAM_TASK_CREATE_TOOL),
    handler: async (raw, context) => {
      onlyLead(context, 'team_task_create')
      const args = (raw ?? {}) as Record<string, unknown>
      const owner = optionalText(args.owner, 'owner')
      const description = args.description === undefined ? undefined : String(args.description)
      const team = await options.team(context.sessionId)
      const task = await team.createTask(leadCall(context).append, {
        title: text(args.title, 'title'),
        ...(description === undefined ? {} : { description }),
        ...(owner === undefined ? {} : { owner }),
        dependsOn: stringList(args.dependsOn, 'dependsOn', 256),
      })
      return { content: `Created task ${task.id}: ${task.title}.`, meta: meta(task) }
    },
  }

  const list: Tool = {
    definition: definition(TEAM_TASK_LIST_TOOL),
    handler: async (_raw, context) => {
      onlyLead(context, 'team_task_list')
      return boardOutput(await options.team(context.sessionId))
    },
  }

  const update: Tool = {
    definition: definition(TEAM_TASK_UPDATE_TOOL),
    handler: async (raw, context) => {
      onlyLead(context, 'team_task_update')
      const team = await options.team(context.sessionId)
      const task = await team.updateTask(leadCall(context).append, TEAM_LEAD_NAME, taskUpdateInput(raw))
      return { content: `Task ${task.id} is ${task.status}${task.owner === undefined ? '' : ` (owner ${task.owner})`}.`, meta: meta(task) }
    },
  }

  return [spawn, send, wait, create, list, update]
}

/** A teammate's own tools (registered in its agent scope), acting as `name`. */
export function teammateTools(team: Team, name: string): Tool[] {
  const send: Tool = {
    definition: definition(SEND_MESSAGE_TOOL),
    handler: async raw => {
      const args = (raw ?? {}) as Record<string, unknown>
      const message = await team.sendFromTeammate(name, text(args.to, 'to').trim(), text(args.text, 'text'))
      return { content: `Message ${message.id} queued for ${message.to}; it is delivered before its next step, or at the start of its next turn when it is not working.`, meta: meta({ id: message.id, to: message.to }) }
    },
  }
  const list: Tool = {
    definition: definition(TEAM_TASK_LIST_TOOL),
    handler: async () => boardOutput(team),
  }
  const update: Tool = {
    definition: definition(TEAM_TASK_UPDATE_TOOL),
    handler: async raw => {
      const task = await team.updateTask(team.teammateSink, name, taskUpdateInput(raw))
      return { content: `Task ${task.id} is ${task.status}${task.owner === undefined ? '' : ` (owner ${task.owner})`}.`, meta: meta(task) }
    },
  }
  const waitFor: Tool = {
    definition: definition(WAIT_FOR_MESSAGE_TOOL),
    handler: async (raw, context) => {
      const args = (raw ?? {}) as Record<string, unknown>
      const teammates = stringList(args.teammates, 'teammates', 16)
      const seconds = args.timeoutSeconds === undefined ? 120 : Number(args.timeoutSeconds)
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new NexgentError('tool/invalid-input', '"timeoutSeconds" must be an integer from 1 to 600')
      const outcome = await team.waitForMessage(name, teammates, seconds * 1000, context.signal)
      const content = outcome.reason === 'mail'
        ? `${outcome.mail} new message${outcome.mail === 1 ? '' : 's'} for you; ${outcome.mail === 1 ? 'it is' : 'they are'} shown before your next step.`
        : outcome.reason === 'finished'
          ? `${outcome.finished.join(', ')} ${outcome.finished.length === 1 ? 'is' : 'are'} not working now (finished or idle); check the files or the task board.`
          : `No message after ${seconds} seconds.`
      return { content, meta: meta(outcome) }
    },
  }
  return [send, list, update, waitFor]
}
