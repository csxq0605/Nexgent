/**
 * Who runs a workflow's members. One `agent()` call is one member: a child
 * session (`executionForm: workflow`) started under the parent session, run
 * for one turn and closed, with `subagent.start` / `subagent.end` (carrying
 * `workflowId`) written to the parent through the request's `record` sink.
 * The shape is `@nexgent/subagent`'s `runMember`: {@link agentsMemberRunner}
 * is that function over `ctx.agents` and the preset registry; tests pass
 * their own runner.
 */
import { intersectToolRestrictions, type AgentPreset, type AgentsService, type ToolRestriction } from '@nexgent/kernel'
import { DEFAULT_PRESET_NAME, sessionPresetRegistry, type CapabilityPresetLookup } from '@nexgent/preset'
import { assertFilesExist, normalizeMemberFiles, runMember, type MemberRecordSink, type MemberRun } from '@nexgent/subagent'

/** One member to run. */
export interface WorkflowMemberRequest {
  /** The parent (root) session running the workflow. */
  readonly parentSessionId: string
  /** Project root (presets and files resolve against it). */
  readonly projectRoot: string
  /** Unique within the workflow. */
  readonly name: string
  readonly workflowId: string
  /** The prompt passed to `agent()`. */
  readonly task: string
  /** Preset name (built-in or `.nexgent/presets/`); default `general-executor`. */
  readonly preset?: string
  /** Narrows the member's tools beyond the preset's. */
  readonly tools?: ToolRestriction
  readonly model?: string
  readonly materialIds?: readonly string[]
  /** Project paths the member should read first. */
  readonly files?: readonly string[]
  /** Rework K4 (audit D11): the member's own request cap for its run. */
  readonly maxRequests?: number
  /** Fires when the workflow is cancelled or its script ends first. */
  readonly signal: AbortSignal
  /** Parent turn and tool call of the `workflow` call. */
  readonly turn: number
  readonly toolCallId: string
  /** Where `subagent.start` / `subagent.end` go (the workflow serializes its records). */
  readonly record: MemberRecordSink
}

/**
 * Run one member end to end. Rejects only when the member cannot start
 * (unknown preset, missing file, a sandbox wider than the parent's, the
 * task tree's member cap) — nothing is recorded then — or a record cannot be
 * written; every turn outcome resolves as a {@link MemberRun}.
 */
export type WorkflowMemberRunner = (request: WorkflowMemberRequest) => Promise<MemberRun>

/** The member's first user message: the task, then the files to read first and how to hand work back. */
export function renderWorkflowMemberPrompt(task: string, files: readonly string[]): string {
  const parts = [task]
  if (files.length > 0) parts.push(`Read these project files first:\n${files.map(file => `- ${file}`).join('\n')}`)
  parts.push('You are one member of a workflow; other members may work in the same project at the same time, so keep to the files your task covers. Hand new output files back with `present`, '
    + 'then end with a short reply: what you did, what you produced and where. That reply is what the workflow reads.')
  return parts.join('\n\n')
}

/** The preset a member runs with: the named one, narrowed by `tools`, with `model` replaced. */
export async function memberPreset(projectRoot: string, request: Pick<WorkflowMemberRequest, 'preset' | 'tools' | 'model'> & { readonly parentSessionId?: string },
  capabilities?: CapabilityPresetLookup): Promise<AgentPreset> {
  const registry = await sessionPresetRegistry(projectRoot, request.parentSessionId ?? '', request.parentSessionId === undefined ? undefined : capabilities)
  const base = await registry.resolve(request.preset ?? DEFAULT_PRESET_NAME)
  const tools = request.tools === undefined ? base.tools : base.tools === undefined ? request.tools : intersectToolRestrictions([base.tools, request.tools])
  return { ...base, ...(tools === undefined ? {} : { tools }), ...(request.model === undefined ? {} : { model: request.model }) }
}

/** The runner over `ctx.agents`: real child sessions through `@nexgent/subagent`'s `runMember`. */
export function agentsMemberRunner(agents: Pick<AgentsService, 'create'>, capabilities?: CapabilityPresetLookup): WorkflowMemberRunner {
  return async request => {
    const files = normalizeMemberFiles(request.projectRoot, request.files ?? [])
    await assertFilesExist(request.projectRoot, files)
    const preset = await memberPreset(request.projectRoot, request, capabilities)
    return runMember({
      agents,
      parentSessionId: request.parentSessionId,
      name: request.name,
      executionForm: 'workflow',
      preset,
      prompt: renderWorkflowMemberPrompt(request.task, files),
      task: request.task,
      ...(request.materialIds === undefined ? {} : { materialIds: request.materialIds }),
      ...(request.maxRequests === undefined ? {} : { budget: { maxRequests: request.maxRequests } }),
      signal: request.signal,
      turn: request.turn,
      toolCallId: request.toolCallId,
      workflowId: request.workflowId,
      record: request.record,
    })
  }
}
