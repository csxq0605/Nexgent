/**
 * The `workflow` tool (`step3-tools.ts` `WORKFLOW_TOOL`, foreground only):
 * exactly one of a script or a declarative graph. A graph is validated,
 * saved under `.nexgent/architectures/` (`architecture-store.ts`) and
 * compiled into a script; then the script runs (`runtime.ts`). Name, schema,
 * effects and approval come from the contract; the description is this
 * package's. The tool needs a host that supports tool records
 * (`ToolContext.appendRecord`).
 */
import { join } from 'node:path'
import { memberReplyExcerpt, memberReplyShare, NexgentError, renderWorkdirMerge, PROJECT_ARCHITECTURES_DIR, WORKFLOW_TOOL, type JsonValue, type Tool, type ToolOutput } from '@nexgent/kernel'
import { saveArchitecture } from './architecture-store.js'
import type { WorkflowMemberRunner } from './runner.js'
import { runWorkflow, type RunWorkflowOptions, type WorkflowRunResult } from './runtime.js'

/**
 * Characters of the script's result shown to the model. Member replies share
 * `COLLABORATION_LIMITS.memberRepliesShownChars` like every collaboration
 * tool (rework K4, audit D10).
 */
export const MAX_SHOWN_RESULT_CHARS = 20_000

/** The model-facing description of `workflow`. */
export const WORKFLOW_DESCRIPTION = 'Orchestrate several members (child sessions) in the foreground and wait for all of them. '
  + 'Use it when the plan is fixed and has dependencies, stages or many items (for a few independent sub-tasks, call delegate several times in one reply instead); members write to their own subdirectories, and you read their results and present the final deliverable yourself. '
  + 'Give exactly one of `script` or `graph`. '
  + 'script: the body of an async JavaScript function that only coordinates (no files, network or Node APIs); `return` a JSON value. It can use: '
  + 'agent(prompt, { name?, preset?, files?, materialIds?, tools?: { allow?, deny? }, model?, maxRequests? }) → { name, status, text, deliverables, usage, requestCount } — runs one member to the end; '
  + 'it throws if the member does not complete: catch it to retry or skip that member, or leave it uncaught to end the workflow failed; '
  + 'parallel([() => agent(...), ...]) → results, waits for all; pipeline(items, stage1, stage2, ...) → per-item results, each stage gets (previous, item, index); '
  + 'phase(title) marks progress; log(...values) prints; args is the `args` input. '
  + 'graph: { nodes: [{ id, prompt, dependencies: [ids], preset?, tools?, model? }] } — each node runs once after its dependencies, with their replies appended to its prompt; the graph is saved for reuse. '
  + 'At most 4 members run at once and 16 members per task; members cannot start members. '
  + 'To give one member a follow-up afterwards, call delegate with its name and member id as continue.'

/** Options of {@link workflowTool}. */
export interface WorkflowToolOptions {
  readonly runner: WorkflowMemberRunner
  /** Host process settings for the script runtime. */
  readonly ptc?: RunWorkflowOptions['ptc']
  readonly maxConcurrentMembers?: number
  readonly maxMembers?: number
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text
}

/** Render a workflow run for the model. */
export function renderWorkflowResult(result: WorkflowRunResult, title: string | undefined, architecture: string | undefined): ToolOutput {
  const name = title === undefined ? `Workflow ${result.workflowId}` : `Workflow "${title}"`
  const counts = new Map<string, number>()
  for (const member of result.members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const tally = [...counts].map(([status, count]) => `${count} ${status}`).join(', ')
  const lines = [`${name} ${result.status}: ${result.members.length} member${result.members.length === 1 ? '' : 's'}${tally === '' ? '' : ` (${tally})`}.`]
  if (result.error !== undefined) lines.push(`Error: ${result.error.message}`)
  if (architecture !== undefined) lines.push(`Graph saved as ${PROJECT_ARCHITECTURES_DIR}/${architecture}.json`)
  const share = memberReplyShare(result.members.length)
  for (const member of result.members) {
    lines.push('', `## ${member.name} (${member.status}, member id ${member.childSessionId})`)
    if (member.files.length > 0) lines.push(`Files: ${member.files.join(', ')}`)
    lines.push(...renderWorkdirMerge(member.merge))
    if (member.text !== '') lines.push(memberReplyExcerpt(member.text, share))
  }
  if (result.output !== '') lines.push('', 'Log:', result.output.endsWith('\n') ? result.output.slice(0, -1) : result.output)
  // A graph's result is its nodes' replies, already shown above.
  if (result.value !== undefined && architecture === undefined) lines.push('', 'Result:', excerpt(JSON.stringify(result.value, null, 2), MAX_SHOWN_RESULT_CHARS))
  return {
    content: lines.join('\n'),
    isError: result.status !== 'completed',
    meta: {
      workflowId: result.workflowId,
      status: result.status,
      ...(architecture === undefined ? {} : { architecture }),
      members: result.members.map(member => ({ name: member.name, childSessionId: member.childSessionId, status: member.status, files: [...member.files] })),
    },
  }
}

/** The `workflow` tool over a member runner. */
export function workflowTool(options: WorkflowToolOptions): Tool {
  return {
    definition: {
      name: WORKFLOW_TOOL.name,
      description: WORKFLOW_DESCRIPTION,
      inputSchema: WORKFLOW_TOOL.inputSchema,
      effects: WORKFLOW_TOOL.effects,
      approval: WORKFLOW_TOOL.approval,
    },
    handler: async (input, context) => {
      const record = (input ?? {}) as Record<string, unknown>
      if ((record.script === undefined) === (record.graph === undefined)) throw new NexgentError('tool/invalid-input', 'give exactly one of "script" or "graph"')
      if (context.member !== undefined) {
        throw new NexgentError('tool/denied', 'members cannot start workflows')
      }
      const appendRecord = context.appendRecord
      // Members never see this tool (MEMBER_DENIED_TOOLS); refuse anyway when one calls it.
      if (appendRecord === undefined) throw new NexgentError('tool/failed', 'this host cannot record workflows (no tool records)')
      const title = typeof record.title === 'string' && record.title.trim() !== '' ? record.title : undefined
      let script: string
      let architecture: string | undefined
      if (record.graph !== undefined) {
        const prepared = await saveArchitecture(join(context.workspace.root, PROJECT_ARCHITECTURES_DIR), record.graph)
        script = prepared.script
        architecture = prepared.version
      } else {
        if (typeof record.script !== 'string' || record.script.trim() === '') throw new NexgentError('tool/invalid-input', '"script" must be a non-empty string')
        script = record.script
      }
      const result = await runWorkflow({
        script,
        kind: architecture === undefined ? 'script' : 'graph',
        ...(architecture === undefined ? {} : { architecture }),
        ...(title === undefined ? {} : { title }),
        ...(record.args === undefined ? {} : { args: record.args as JsonValue }),
        runner: options.runner,
        parentSessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        appendRecord,
        cwd: context.workspace.root,
        signal: context.signal,
        ...(options.ptc === undefined ? {} : { ptc: options.ptc }),
        ...(options.maxConcurrentMembers === undefined ? {} : { maxConcurrentMembers: options.maxConcurrentMembers }),
        ...(options.maxMembers === undefined ? {} : { maxMembers: options.maxMembers }),
      })
      return renderWorkflowResult(result, title, architecture)
    },
  }
}
