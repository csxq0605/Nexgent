/**
 * The `delegate` tool (`agent-hooks.md` §步骤 3 工具): run one sub-task in a
 * child session (`executionForm: delegated`) in the foreground and return
 * what it produced. Name, input schema, effects (`read`) and approval
 * (`never`) are frozen in the contract `DELEGATE_TOOL`; the member's own
 * tool calls are checked one by one under the member's rules.
 */
import {
  BUILTIN_PRESET_NAMES,
  DELEGATE_TOOL,
  MEMBER_NAME_PATTERN,
  NexgentError,
  type AgentPreset,
  type AgentsService,
  type DelegateToolInput,
  type JsonValue,
  type KernelToolContext,
  type MemberResult,
  type TaskingService,
  type Tool,
  type ToolContext,
  type ToolOutput,
  type UsageCount,
} from '@nexgent/kernel'
import { DEFAULT_PRESET_NAME, sessionPresetRegistry, type CapabilityPresetLookup } from '@nexgent/preset'
import { assertFilesExist, normalizeMemberFiles } from './files.js'
import { runMember, type MemberRun } from './runner.js'

/** Options of {@link delegateTool}. */
export interface DelegateToolOptions {
  /** `ctx.agents` (only `create` is used). */
  readonly agents: Pick<AgentsService, 'create'>
  /** The tasking service, when loaded: material ids are checked against it before the member starts. */
  readonly tasking?: () => TaskingService | undefined
  /** `ctx.capabilities`, when loaded: presets of the session's capability version and the ones it tried. */
  readonly capabilities?: CapabilityPresetLookup
}

/** Model-facing description. */
export const DELEGATE_DESCRIPTION = 'Hand one self-contained sub-task to a member (a separate agent session) and wait for its result. '
  + 'mode "fresh" (default): the member sees only your task text, the listed files and the materials, so state the goal, inputs, '
  + 'what to produce and where. mode "fork": the member also sees this conversation up to the end of the previous turn. '
  + 'The member works in the same project directory with your sandbox mode or a narrower one, cannot delegate further, '
  + 'and returns its last reply, the deliverables it presented (ids, versions, files) and its request and token use. '
  + 'Read its files yourself before you build on them. '
  + `Presets: ${BUILTIN_PRESET_NAMES.join(', ')} (default ${DEFAULT_PRESET_NAME}), or a project preset in .nexgent/presets/; `
  + 'persona replaces the preset\'s persona but never widens its tools or sandbox.'

function stringList(value: unknown, field: string, max: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new NexgentError('tool/invalid-input', `"${field}" must be an array of at most ${max} non-empty strings`)
  }
  return value.map(item => (item as string).trim())
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new NexgentError('tool/invalid-input', `"${field}" must be a non-empty string`)
  return value.trim()
}

/**
 * Check the model's arguments beyond what the schema already did.
 * @throws `tool/invalid-input`.
 */
export function parseDelegateInput(input: unknown): DelegateToolInput {
  const args = (input ?? {}) as Record<string, unknown>
  if (typeof args.name !== 'string' || !MEMBER_NAME_PATTERN.test(args.name)) {
    throw new NexgentError('tool/invalid-input', `"name" must match ${String(MEMBER_NAME_PATTERN)} (lowercase letters, digits and dashes, starting with a letter)`)
  }
  const task = optionalText(args.task, 'task')
  if (task === undefined) throw new NexgentError('tool/invalid-input', '"task" must be a non-empty string')
  if (args.mode !== undefined && args.mode !== 'fresh' && args.mode !== 'fork') throw new NexgentError('tool/invalid-input', '"mode" must be fresh or fork')
  const preset = optionalText(args.preset, 'preset')
  const persona = optionalText(args.persona, 'persona')
  const materialIds = stringList(args.materialIds, 'materialIds', 50)
  const files = stringList(args.files, 'files', 50)
  const expectedOutput = optionalText(args.expectedOutput, 'expectedOutput')
  return {
    name: args.name,
    task,
    ...(args.mode === undefined ? {} : { mode: args.mode }),
    ...(preset === undefined ? {} : { preset }),
    ...(persona === undefined ? {} : { persona }),
    ...(materialIds === undefined ? {} : { materialIds: [...new Set(materialIds)] }),
    ...(files === undefined ? {} : { files }),
    ...(expectedOutput === undefined ? {} : { expectedOutput }),
  }
}

/** The member's first user message: the task, the files to read first, the expected output, and how to hand work back. */
export function renderDelegatePrompt(input: Pick<DelegateToolInput, 'task' | 'expectedOutput'>, files: readonly string[]): string {
  const parts = [input.task]
  if (files.length > 0) parts.push(`Read these project files first:\n${files.map(file => `- ${file}`).join('\n')}`)
  if (input.expectedOutput !== undefined) parts.push(`Expected output: ${input.expectedOutput}`)
  parts.push('When you are done, hand back any files you produced with `present`, then end with a short reply: what you did, '
    + 'what you produced and where, and anything left open. That reply is what the requester reads.')
  return parts.join('\n\n')
}

function count(value: UsageCount): string {
  return value === 'unknown' ? '?' : String(value)
}

/** The model-facing text of a member run (`MemberResult` as text). */
export function renderMemberResult(run: Pick<MemberRun, 'name' | 'childSessionId' | 'result'>): string {
  const { result } = run
  const lines = [`Member ${run.name} finished: ${result.status} (session ${run.childSessionId}).`]
  lines.push(`Use: ${result.requestCount} model request(s), ${count(result.usage.inputTokens)} input / ${count(result.usage.outputTokens)} output tokens`
    + ` (cache read ${count(result.usage.cacheReadTokens)}, cache write ${count(result.usage.cacheWriteTokens)}).`)
  if (result.error !== undefined) lines.push(`Error: ${result.error.code}: ${result.error.message}`)
  if (result.deliverables.length === 0) {
    lines.push('Deliverables: none presented.')
  } else {
    lines.push('Deliverables:')
    for (const version of result.deliverables) {
      lines.push(`- ${version.title} (deliverable ${version.deliverableId}, version ${version.version}): ${version.files.map(file => file.path).join(', ')}`)
      if (version.summary !== '') lines.push(`  ${version.summary}`)
    }
  }
  lines.push('', result.text === '' ? '(The member gave no final reply.)' : `Final reply:\n${result.text}`)
  return lines.join('\n')
}

/** Statuses the tool reports as an error result (anything but a completed run). */
function isFailure(result: MemberResult): boolean {
  return result.status !== 'completed'
}

async function resolvePreset(root: string, sessionId: string, input: DelegateToolInput, capabilities?: CapabilityPresetLookup): Promise<AgentPreset> {
  const preset = await (await sessionPresetRegistry(root, sessionId, capabilities)).resolve(input.preset ?? DEFAULT_PRESET_NAME)
  return input.persona === undefined ? preset : { ...preset, persona: input.persona }
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

/** `delegate`. */
export function delegateTool(options: DelegateToolOptions): Tool {
  return {
    definition: {
      name: DELEGATE_TOOL.name,
      description: DELEGATE_DESCRIPTION,
      inputSchema: DELEGATE_TOOL.inputSchema,
      effects: [...DELEGATE_TOOL.effects],
      approval: DELEGATE_TOOL.approval,
    },
    handler: async (raw: unknown, context: ToolContext): Promise<ToolOutput> => {
      // Depth 1 (ADR 0004): members never see this tool; refuse here too, where the decision is made.
      if (context.member !== undefined) throw new NexgentError('tool/denied', 'members cannot delegate (depth 1)')
      const appendRecord = (context as Partial<KernelToolContext>).appendRecord
      if (appendRecord === undefined) throw new NexgentError('internal', 'delegate needs a host that records tool records')
      const input = parseDelegateInput(raw)
      const root = context.workspace.root
      const files = normalizeMemberFiles(root, input.files ?? [])
      await assertFilesExist(root, files)
      const materialIds = input.materialIds ?? []
      await checkMaterials(options.tasking?.(), materialIds)
      const preset = await resolvePreset(root, context.sessionId, input, options.capabilities)
      const run = await runMember({
        agents: options.agents,
        parentSessionId: context.sessionId,
        name: input.name,
        executionForm: 'delegated',
        preset,
        mode: input.mode ?? 'fresh',
        prompt: renderDelegatePrompt(input, files),
        task: input.task,
        materialIds,
        signal: context.signal,
        turn: context.turn,
        toolCallId: context.callId,
        record: appendRecord,
      })
      const meta = JSON.parse(JSON.stringify({ childSessionId: run.childSessionId, childTurn: run.childTurn, name: run.name, result: run.result })) as JsonValue
      return { content: renderMemberResult(run), isError: isFailure(run.result), meta }
    },
  }
}
