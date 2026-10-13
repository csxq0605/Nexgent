/**
 * The three capability tools (`agent-hooks.md` §步骤 4 工具; names, schemas,
 * effects and approval frozen in `step4-tools.ts`). Members never see them
 * (`MEMBER_DENIED_TOOLS`); the handlers refuse a member anyway.
 */
import {
  CAPABILITY_COMPONENT_KINDS,
  CAPABILITY_DRAFT_TOOL,
  CAPABILITY_PROPOSE_TOOL,
  CAPABILITY_TRY_TOOL,
  COMPONENT_NAME_PATTERN,
  componentDir,
  NexgentError,
  type CapabilityComponentKind,
  type CapabilityComponentRef,
  type CapabilityDraftToolInput,
  type CapabilityProposeToolInput,
  type ComponentUseProof,
  type SessionRecord,
  type Step4ToolSpec,
  type Tool,
  type ToolContext,
  type ToolRecordInput,
} from '@nexgent/kernel'
import { writeCandidate, type ProposedComponent } from './candidates.js'
import { applyDraft, draftDirectory, readComponentDirectory } from './drafts.js'
import { componentFormat } from './formats.js'
import { findUseProof } from './proofs.js'
import type { CapabilityService } from './service.js'
import { readComponentFiles } from './store.js'

const DRAFT_DESCRIPTION = [
  'Create or change one reusable capability component in this session\'s private draft area (not the project). '
    + '`files` are written relative to the component directory; `remove` deletes files. The kind\'s entry file must exist afterwards. '
    + 'Drafts do nothing until you call capability_try, which checks the format below.',
  '',
  `function-module: ${componentFormat('function-module')}`,
  `skill: ${componentFormat('skill')}`,
  `context-policy: ${componentFormat('context-policy')}`,
  `preset: ${componentFormat('preset')}`,
  `team-template: ${componentFormat('team-template')}`,
  `architecture: ${componentFormat('architecture')}`,
  `plugin (runs in the host, the user must approve it): ${componentFormat('plugin')}`,
].join('\n')
const TRY_DESCRIPTION = 'Load the current draft of one component into this session only: a skill joins your skill list, a function module\'s functions become tools named cap_<module>_<function>, a preset or team template becomes usable by delegate / spawn_teammate, a context policy applies from the next turn. '
  + 'Other sessions do not see it. Trying a plugin asks the user first. '
  + 'When the capability version this session runs on already has this component with the same content, nothing is loaded and the call succeeds: use the component as it is.'
const PROPOSE_DESCRIPTION = 'Submit tried components as one candidate for future tasks. Each component must have been used successfully in this session after it was last tried (e.g. a call of its tool, load_skill of the skill). '
  + 'After the task ends the candidate is compared against the current version on past tasks and adopted only if it is better. '
  + 'A component the current capability version already has with the same content is not proposed again; the call succeeds and says so.'

/** Step of the call (kernel contexts carry it). */
function stepOf(context: ToolContext): number {
  const step = (context as ToolContext & { readonly step?: unknown }).step
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1) throw new NexgentError('tool/failed', 'this host does not pass the current step; capability tools cannot record')
  return step
}

function record(context: ToolContext): (record: ToolRecordInput) => Promise<void> {
  if (context.appendRecord === undefined) throw new NexgentError('tool/failed', 'this host cannot record capability tools (no tool records)')
  return context.appendRecord
}

function rootOnly(context: ToolContext, tool: string): void {
  if (context.member !== undefined) throw new NexgentError('tool/denied', `members cannot use ${tool}`)
}

function componentRef(input: { readonly kind?: unknown; readonly name?: unknown }): CapabilityComponentRef {
  if (!CAPABILITY_COMPONENT_KINDS.includes(input.kind as CapabilityComponentKind)) {
    throw new NexgentError('tool/invalid-input', `kind must be one of ${CAPABILITY_COMPONENT_KINDS.join(', ')}`)
  }
  if (typeof input.name !== 'string' || !COMPONENT_NAME_PATTERN.test(input.name)) {
    throw new NexgentError('tool/invalid-input', 'name must be lowercase letters, digits and dashes, starting with a letter (at most 64 characters)')
  }
  return { kind: input.kind as CapabilityComponentKind, name: input.name }
}

function definition(spec: Step4ToolSpec, description: string): Tool['definition'] {
  return { name: spec.name, description, inputSchema: spec.inputSchema, effects: [...spec.effects], approval: spec.approval }
}

function sameFiles(left: ReadonlyMap<string, Uint8Array>, right: ReadonlyMap<string, Uint8Array>): boolean {
  if (left.size !== right.size) return false
  for (const [path, bytes] of left) {
    const other = right.get(path)
    if (other === undefined || !Buffer.from(bytes).equals(Buffer.from(other))) return false
  }
  return true
}

/**
 * The capability version the session runs on, when it already holds this
 * component with exactly the content the session would try or propose
 * (`content`; absent: the session has no copy of its own). A replayed task
 * that drafts, tries and proposes a component its version already carries
 * (the gate's candidate side) then succeeds without a new draft or candidate.
 */
async function alreadyInVersion(service: CapabilityService, sessionId: string, component: CapabilityComponentRef,
  content: ReadonlyMap<string, Uint8Array> | undefined): Promise<string | undefined> {
  const version = await service.sessionVersion(sessionId)
  if (version === 'baseline') return undefined
  const bundle = await service.sessionBundle(sessionId)
  if (!bundle.manifest.components.some(item => item.kind === component.kind && item.name === component.name)) return undefined
  if (content === undefined || content.size === 0) return version
  const adopted = new Map((await readComponentFiles(bundle, component)).map(file => [file.path, typeof file.content === 'string' ? new Uint8Array(Buffer.from(file.content)) : file.content] as const))
  return sameFiles(content, adopted) ? version : undefined
}

function inVersionText(component: CapabilityComponentRef, version: string): string {
  return `${componentDir(component.kind, component.name)} is already in the capability version this session runs on (${version}) with the same content; nothing to load or propose, use it as it is.`
}

/** Read a session's records through the host's session store. */
export type RecordReader = (sessionId: string) => Promise<readonly SessionRecord[]>

/** `capability_draft`. */
export function capabilityDraftTool(service: CapabilityService, readRecords: RecordReader): Tool {
  return {
    definition: definition(CAPABILITY_DRAFT_TOOL, DRAFT_DESCRIPTION),
    handler: async (raw, context) => {
      rootOnly(context, CAPABILITY_DRAFT_TOOL.name)
      const input = (raw ?? {}) as CapabilityDraftToolInput
      const component = componentRef(input)
      const append = record(context)
      const step = stepOf(context)
      const files = await applyDraft(service.store.directory, context.sessionId, component, {
        ...(input.files === undefined ? {} : { files: input.files }),
        ...(input.remove === undefined ? {} : { remove: input.remove }),
      })
      const previous = (await readRecords(context.sessionId))
        .filter(item => item.type === 'capability.draft' && item.component.kind === component.kind && item.component.name === component.name).length
      const revision = previous + 1
      await append({ type: 'capability.draft', turn: context.turn, step, toolCallId: context.callId, component, files, revision })
      return {
        content: `Draft ${componentDir(component.kind, component.name)} revision ${revision}: ${files.map(file => file.path).join(', ')}. Call capability_try to load it into this session.`,
        meta: { component: { ...component }, revision, files: files.map(file => ({ ...file })) },
      }
    },
  }
}

/** `capability_try`. */
export function capabilityTryTool(service: CapabilityService, readRecords: RecordReader): Tool {
  return {
    definition: definition(CAPABILITY_TRY_TOOL, TRY_DESCRIPTION),
    handler: async (raw, context) => {
      rootOnly(context, CAPABILITY_TRY_TOOL.name)
      const component = componentRef((raw ?? {}) as Record<string, unknown>)
      const append = record(context)
      const step = stepOf(context)
      const revision = (await readRecords(context.sessionId))
        .filter(item => item.type === 'capability.draft' && item.component.kind === component.kind && item.component.name === component.name).length
      const tried = (await service.components(context.sessionId, component.kind)).some(item => item.name === component.name && item.version === 'draft')
      if (!tried) {
        const draft = revision === 0 ? undefined : await readComponentDirectory(draftDirectory(service.store.directory, context.sessionId, component))
        const version = await alreadyInVersion(service, context.sessionId, component, draft)
        if (version !== undefined) {
          const tools = await service.toolsOf(context.sessionId, component)
          return {
            content: `${inVersionText(component, version)}${tools.length === 0 ? '' : ` Its tools: ${tools.join(', ')}.`}`,
            meta: { component: { ...component }, alreadyInVersion: version, tools: [...tools] },
          }
        }
      }
      if (revision === 0) throw new NexgentError('tool/invalid-input', `no draft of ${componentDir(component.kind, component.name)} in this session; write it with capability_draft first`)
      const active = await service.tryDraft(context, component, revision)
      const tools = await service.toolsOf(context.sessionId, component)
      await append({ type: 'capability.try', turn: context.turn, step, toolCallId: context.callId, component, revision, ...(tools.length === 0 ? {} : { tools: [...tools] }) })
      const effect = tools.length > 0
        ? `New tools in this session: ${tools.join(', ')}.`
        : active.kind === 'skill'
          ? `Load it with load_skill { "name": "${component.name}" }.`
          : active.kind === 'context-policy'
            ? 'It applies from the next turn.'
            : 'It is available to this session\'s collaboration tools.'
      return { content: `Loaded draft ${componentDir(component.kind, component.name)} revision ${revision} into this session. ${effect}`, meta: { component: { ...component }, revision, tools: [...tools] } }
    },
  }
}

/** `capability_propose`. */
export function capabilityProposeTool(service: CapabilityService, readRecords: RecordReader): Tool {
  return {
    definition: definition(CAPABILITY_PROPOSE_TOOL, PROPOSE_DESCRIPTION),
    handler: async (raw, context) => {
      rootOnly(context, CAPABILITY_PROPOSE_TOOL.name)
      const input = (raw ?? {}) as CapabilityProposeToolInput
      if (!Array.isArray(input.components) || input.components.length === 0 || input.components.length > 16) {
        throw new NexgentError('tool/invalid-input', 'components must list 1 to 16 { kind, name } entries')
      }
      if (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length === 0 || input.summary.length > 500)) {
        throw new NexgentError('tool/invalid-input', 'summary must be 1 to 500 characters')
      }
      const refs = input.components.map(componentRef)
      if (new Set(refs.map(ref => `${ref.kind}/${ref.name}`)).size !== refs.length) throw new NexgentError('tool/invalid-input', 'a component is listed twice')
      const append = record(context)
      const step = stepOf(context)
      const records = await readRecords(context.sessionId)
      const triedNow = new Map((await service.components(context.sessionId)).filter(item => item.version === 'draft').map(item => [`${item.kind}/${item.name}`, item]))
      const inVersion: { readonly ref: CapabilityComponentRef; readonly version: string }[] = []
      const pending: CapabilityComponentRef[] = []
      for (const ref of refs) {
        const tried = triedNow.get(`${ref.kind}/${ref.name}`)
        const drafted = records.some(item => item.type === 'capability.draft' && item.component.kind === ref.kind && item.component.name === ref.name)
        const content = tried !== undefined
          ? await readComponentDirectory(tried.directory)
          : drafted ? await readComponentDirectory(draftDirectory(service.store.directory, context.sessionId, ref)) : undefined
        const version = await alreadyInVersion(service, context.sessionId, ref, content)
        if (version === undefined) pending.push(ref)
        else inVersion.push({ ref, version })
      }
      if (pending.length === 0) {
        return {
          content: inVersion.map(item => inVersionText(item.ref, item.version)).join(' '),
          meta: { alreadyInVersion: inVersion.map(item => ({ ...item.ref, version: item.version })) },
        }
      }
      const proofs: ComponentUseProof[] = []
      const missing: string[] = []
      for (const ref of pending) {
        const proof = findUseProof(records, ref)
        if (typeof proof === 'string') missing.push(`${componentDir(ref.kind, ref.name)}: ${proof}`)
        else proofs.push(proof)
      }
      if (missing.length > 0) throw new NexgentError('tool/failed', `not proposed; a component needs a successful use after it was tried. ${missing.join('; ')}`, { details: { missing } })
      const tried = new Map((await service.components(context.sessionId)).filter(item => item.version === 'draft').map(item => [`${item.kind}/${item.name}`, item]))
      const components: ProposedComponent[] = []
      for (const ref of pending) {
        const active = tried.get(`${ref.kind}/${ref.name}`)
        if (active === undefined) throw new NexgentError('tool/failed', `${componentDir(ref.kind, ref.name)} is not loaded in this session any more; try it again`)
        components.push({ ...ref, files: await readComponentDirectory(active.directory) })
      }
      const taskId = context.attribution?.taskId
      if (taskId === undefined) throw new NexgentError('tool/failed', 'this host does not attribute tasks; cannot propose')
      // Step 5: an improvement job's propose session marks its candidate (origin and job).
      const start = records[0]
      const improvement = start?.type === 'session.start' && start.purpose === 'improvement' ? start.improvement : undefined
      const { record: candidate } = await writeCandidate(service.store.directory, {
        sessionId: context.sessionId,
        taskId,
        turn: context.turn,
        base: await service.sessionBundle(context.sessionId),
        components,
        proofs,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(improvement === undefined ? {} : { origin: 'improvement' as const, jobId: improvement.jobId }),
      })
      await append({ type: 'capability.propose', turn: context.turn, step, toolCallId: context.callId, candidateId: candidate.id, proofs })
      return {
        content: `Proposed candidate ${candidate.id} with ${pending.map(ref => componentDir(ref.kind, ref.name)).join(', ')}. `
          + inVersion.map(item => `${inVersionText(item.ref, item.version)} `).join('')
          + (candidate.requiresApproval ? 'It contains a plugin: after the gate it waits for the user\'s approval.' : 'It is compared against the current version on past tasks after this task ends.'),
        meta: { candidateId: candidate.id, version: candidate.version, requiresApproval: candidate.requiresApproval },
      }
    },
  }
}

/** All three tools. */
export function capabilityTools(service: CapabilityService, readRecords: RecordReader): Tool[] {
  return [capabilityDraftTool(service, readRecords), capabilityTryTool(service, readRecords), capabilityProposeTool(service, readRecords)]
}
