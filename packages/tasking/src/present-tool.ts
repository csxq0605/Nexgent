/**
 * The `present` tool: the model declares project files as a deliverable; the
 * host snapshots them into `.nexgent/outputs/` and records
 * `deliverable.presented`. Name, schema, effects and approval are frozen in
 * `PRESENT_TOOL` (`step2-tools.ts`); the description is ours.
 */
import {
  NexgentError,
  PRESENT_TOOL,
  toDeliverableVersionRef,
  type DeliverableStore,
  type DeliverableVersion,
  type DeliverableVersionRef,
  type JsonValue,
  type PresentToolInput,
  type Tool,
  type ToolContext,
} from '@nexgent/kernel'

/** Model-facing description of `present`. */
export const PRESENT_DESCRIPTION = [
  'Hand finished work to the user as a deliverable. Give the project files that make up the result (the first is the main file) and one sentence on what it is or what changed.',
  'The files are snapshotted as a new version the user can open, compare and comment on; later edits in the project do not change a presented version.',
  'Call it again after each revision, passing the deliverableId from the earlier result so the snapshot becomes the next version of the same deliverable.',
  'Only files inside the project can be presented, not files under .nexgent/.',
].join(' ')

/** The `step` of the running call when the host passes it (the kernel's tool context does). */
function stepOf(context: ToolContext): number | undefined {
  const step = (context as ToolContext & { readonly step?: unknown }).step
  return typeof step === 'number' && Number.isInteger(step) && step >= 1 ? step : undefined
}

/** The record's version reference; `toDeliverableVersionRef` predates the step-3 `memberName`, so it is added here. */
function versionRef(version: DeliverableVersion): DeliverableVersionRef {
  const ref = toDeliverableVersionRef(version)
  return version.memberName === undefined ? ref : { ...ref, memberName: version.memberName }
}

/** Tool result text for a presented version. Pure. */
export function renderPresentResult(version: DeliverableVersion): string {
  const files = version.files.map(file => `- ${file.path} (${file.size} bytes)`).join('\n')
  return [
    `Presented deliverable ${version.deliverableId} version ${version.version}: ${version.title}.`,
    files,
    `To present a revision of this deliverable, call present again with deliverableId "${version.deliverableId}".`,
  ].join('\n')
}

/** Build the `present` tool over a deliverable store. */
export function presentTool(deliverables: DeliverableStore): Tool {
  return {
    definition: {
      name: PRESENT_TOOL.name,
      description: PRESENT_DESCRIPTION,
      inputSchema: PRESENT_TOOL.inputSchema,
      effects: PRESENT_TOOL.effects,
      approval: PRESENT_TOOL.approval,
    },
    async handler(input, context) {
      const args = input as PresentToolInput
      const step = stepOf(context)
      if (context.appendRecord !== undefined && step === undefined) {
        // Without the step the record would not validate; fail before writing any snapshot.
        throw new NexgentError('tool/failed', 'present cannot record the deliverable: the host did not pass the current step')
      }
      const version = await deliverables.present({
        sessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        paths: args.paths,
        summary: args.summary,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.deliverableId === undefined ? {} : { deliverableId: args.deliverableId }),
        ...(context.member === undefined ? {} : { member: { memberId: context.sessionId, memberName: context.member.name } }),
      })
      if (context.appendRecord !== undefined) {
        await context.appendRecord({
          type: 'deliverable.presented',
          turn: context.turn,
          step: step!,
          toolCallId: context.callId,
          deliverable: versionRef(version),
        })
      }
      const meta: JsonValue = {
        deliverableId: version.deliverableId,
        version: version.version,
        title: version.title,
        files: version.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256, mediaType: file.mediaType })),
      }
      return { content: renderPresentResult(version), meta }
    },
  }
}
