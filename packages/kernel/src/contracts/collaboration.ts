/**
 * The step-3 collaboration contract: execution forms, child sessions
 * (delegates, teammates, workflow members), presets, the member result a
 * child hands back, team and workflow state, the declarative workflow graph,
 * and the limits every implementation enforces.
 *
 * Normative text: `docs/adr/0004-execution-forms.md` (decisions),
 * `docs/spec/data-formats.md` §子会话与成员, §团队, §工作流, §预设, §架构图存储
 * (formats) and `docs/spec/permissions.md` §子会话继承 (sandbox, tools,
 * approvals, cost, cancellation). Types and pure helpers only.
 */
import { NexgentError } from './errors.js'
import type { ErrorInfo } from './errors.js'
import type { JsonSchema } from './json.js'
import type { Effort, LLMUsage, ThinkingMode } from './llm.js'
import type { DeliverableVersionRef } from './tasking.js'
import { assertToolRestriction, type ToolRestriction } from './tools.js'
import { SANDBOX_MODES, type SandboxMode } from './workspace.js'

// ---------------------------------------------------------------------------
// Execution forms and attribution
// ---------------------------------------------------------------------------

/**
 * How a member executes: the main conversation itself (`direct`), a child it
 * delegated one sub-task to (`delegated`), a named teammate (`team`), or a
 * member started by a workflow script or graph (`workflow`).
 */
export type ExecutionForm = 'direct' | 'delegated' | 'team' | 'workflow' | 'thread'

/** Every execution form, in the order above. */
export const EXECUTION_FORMS: readonly ExecutionForm[] = ['direct', 'delegated', 'team', 'workflow', 'thread']

/** The forms a child session can have (never `direct`). */
export type MemberExecutionForm = Exclude<ExecutionForm, 'direct'>

/** `memberId` of the main conversation (the root session of a task tree). */
export const MAIN_MEMBER_ID = 'main'

/**
 * What the kernel stamps on every ledger record and `task.outcome` of a
 * session (`permissions.md` §子会话继承, H10). `memberId` is
 * {@link MAIN_MEMBER_ID} for the root session and the child's session id for
 * a child; `taskId` is shared by the whole tree.
 */
export interface AgentAttribution {
  /** Lowercase uuid v4 minted when the root agent opens (create or resume); children inherit it. */
  readonly taskId: string
  readonly memberId: string
  readonly executionForm: ExecutionForm
}

/** Pattern of a member name (delegate label, teammate name, workflow node id). */
export const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Who a child session is: written into its `session.start.member` and shown in the UI. */
export interface MemberIdentity {
  /** Display and addressing name; matches {@link MEMBER_NAME_PATTERN}; unique among a team's live members. */
  readonly name: string
  readonly executionForm: MemberExecutionForm
  /** Preset the member was started with, when one was named. */
  readonly preset?: string
}

/**
 * The identity line the kernel puts in a child session's system prompt
 * (`agent-hooks.md` §步骤 3 系统提示增量). The exact text is part of the
 * contract: scripted-provider tests route requests to members by it (a forked
 * child's first user message equals its parent's, so only the system prompt
 * tells them apart). Root sessions have no such line.
 */
export function renderMemberPromptLine(member: Pick<MemberIdentity, 'name' | 'executionForm'>): string {
  return `Member: ${member.name} (${member.executionForm})`
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Pattern of a preset name (file base name under `.nexgent/presets/`). */
export const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Directory, relative to the project root, of project presets (`<name>.json`). */
export const PROJECT_PRESETS_DIR = '.nexgent/presets'

/** Names of the built-in presets (`data-formats.md` §预设). */
export const BUILTIN_PRESET_NAMES = ['read-only-analyst', 'read-only-checker', 'general-executor', 'explorer'] as const

/**
 * A member's persona, tool scope and model parameters. Every field except
 * `name` / `description` only narrows what the member inherits: `tools`
 * intersects with the parent's visible set, `sandboxMode` may not be wider
 * than the parent's (see {@link isSandboxWithin}).
 */
export interface AgentPreset {
  readonly name: string
  /** One line: what this member is for (shown to the model choosing a preset). */
  readonly description: string
  /** Replaces the default persona paragraph of the system prompt; the rest of the prompt is the kernel's. */
  readonly persona?: string
  /** Applied with a scoped `restrict()`; {@link MEMBER_DENIED_TOOLS} are always denied on top. */
  readonly tools?: ToolRestriction
  readonly sandboxMode?: SandboxMode
  readonly model?: string
  readonly effort?: Effort
  readonly thinking?: ThinkingMode
  /** Max model calls per member turn; default the `agents` row's `maxSteps`. */
  readonly maxSteps?: number
}

/** A preset file: `.nexgent/presets/<name>.json` (the `name` field must equal the base name). */
export interface PresetFile extends AgentPreset {
  readonly formatVersion: 1
}

/** JSON Schema of a {@link PresetFile} (patterns are checked by {@link assertPresetFile}). */
export const PRESET_FILE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'name', 'description'],
  properties: {
    formatVersion: { const: 1 },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    description: { type: 'string', minLength: 1 },
    persona: { type: 'string', minLength: 1 },
    tools: {
      type: 'object',
      additionalProperties: false,
      properties: { allow: { type: 'array', items: { type: 'string' } }, deny: { type: 'array', items: { type: 'string' } } },
    },
    sandboxMode: { enum: [...SANDBOX_MODES] },
    model: { type: 'string', minLength: 1 },
    effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    thinking: { enum: ['off', 'on'] },
    maxSteps: { type: 'integer', minimum: 1 },
  },
}

function nonEmpty(record: Record<string, unknown>, key: string, optional: boolean): void {
  const value = record[key]
  if (value === undefined && optional) return
  if (typeof value !== 'string' || value.trim() === '') throw new NexgentError('config/invalid', `preset ${key} must be a non-empty string`)
}

/**
 * Validate an untrusted preset file (project `.nexgent/presets/*.json`).
 * @throws `config/invalid` naming the offending field.
 */
export function assertPresetFile(value: unknown): asserts value is PresetFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new NexgentError('config/invalid', 'preset must be an object')
  const record = value as Record<string, unknown>
  const known = Object.keys(PRESET_FILE_SCHEMA.properties as Record<string, unknown>)
  const extra = Object.keys(record).filter(key => !known.includes(key))
  if (extra.length > 0) throw new NexgentError('config/invalid', `preset has unknown fields: ${extra.join(', ')}`)
  if (record.formatVersion !== 1) throw new NexgentError('config/invalid', 'preset formatVersion must be 1')
  if (typeof record.name !== 'string' || !PRESET_NAME_PATTERN.test(record.name)) {
    throw new NexgentError('config/invalid', `preset name must match ${String(PRESET_NAME_PATTERN)}`)
  }
  nonEmpty(record, 'description', false)
  nonEmpty(record, 'persona', true)
  nonEmpty(record, 'model', true)
  if (record.tools !== undefined) assertToolRestriction(record.tools)
  if (record.sandboxMode !== undefined && !SANDBOX_MODES.includes(record.sandboxMode as SandboxMode)) {
    throw new NexgentError('config/invalid', 'preset sandboxMode is not a sandbox mode')
  }
  if (record.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(record.effort as string)) {
    throw new NexgentError('config/invalid', 'preset effort is not an effort level')
  }
  if (record.thinking !== undefined && record.thinking !== 'off' && record.thinking !== 'on') {
    throw new NexgentError('config/invalid', 'preset thinking must be off or on')
  }
  if (record.maxSteps !== undefined && !(Number.isInteger(record.maxSteps) && (record.maxSteps as number) >= 1)) {
    throw new NexgentError('config/invalid', 'preset maxSteps must be a positive integer')
  }
}

// ---------------------------------------------------------------------------
// Sandbox narrowing
// ---------------------------------------------------------------------------

/** Width of each sandbox mode: read-only < workspace-write < full-access. */
export const SANDBOX_RANK: Readonly<Record<SandboxMode, number>> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }

/** Whether `child` is no wider than `parent`. */
export function isSandboxWithin(child: SandboxMode, parent: SandboxMode): boolean {
  return SANDBOX_RANK[child] <= SANDBOX_RANK[parent]
}

/**
 * The mode a child runs in: the narrowest of the parent's mode and every
 * requested mode (preset, explicit option). A request wider than the parent
 * is an error, not a silent clamp (H12).
 * @throws `sandbox/denied` when a request is wider than `parent`.
 */
export function childSandboxMode(parent: SandboxMode, ...requested: readonly (SandboxMode | undefined)[]): SandboxMode {
  let mode = parent
  for (const request of requested) {
    if (request === undefined) continue
    if (!isSandboxWithin(request, parent)) {
      throw new NexgentError('sandbox/denied', `a member may not run in ${request} under a ${parent} parent`, { details: { parent, requested: request } })
    }
    if (SANDBOX_RANK[request] < SANDBOX_RANK[mode]) mode = request
  }
  return mode
}

// ---------------------------------------------------------------------------
// Child agents
// ---------------------------------------------------------------------------

/** Fresh: only the task text and materials. Fork: the parent's history up to its last completed turn, too. */
export type DelegationMode = 'fresh' | 'fork'

/**
 * A child's own share of the task-tree cost cap. The tree as a whole is
 * bounded by the root's `costCaps.perTask`; a share can only lower what this
 * child may spend, never raise it.
 */
export interface BudgetShare {
  readonly maxRequests?: number
  readonly maxTokens?: number
}

/**
 * What makes `ctx.agents.create` start a child session instead of a root
 * one (`CreateAgentOptions.child`). The parent must be an agent open in the
 * same process and must itself be a root session (depth 1).
 */
export interface ChildAgentOptions {
  /** The open parent agent's session id; written as `session.start.parentSessionId`. */
  readonly parentSessionId: string
  readonly member: MemberIdentity
  /** Resolved preset (the registry looks names up; the kernel receives the object). */
  readonly preset?: AgentPreset
  /** Explicit sandbox request; narrowed with the preset's by {@link childSandboxMode}. */
  readonly sandboxMode?: SandboxMode
  /** `fork` copies the parent's history into a `fork.seed` record; default `fresh`. */
  readonly mode?: DelegationMode
  readonly budget?: BudgetShare
}

/** What `ctx.agents.resume` needs to reopen a child under its (live) parent, e.g. a teammate in a later Lead turn. */
export interface ResumeChildOptions {
  /** Must equal the child's `session.start.parentSessionId`. */
  readonly parentSessionId: string
  readonly budget?: BudgetShare
}

/** How a member's run ended, as its parent sees it. */
export type MemberResultStatus = 'completed' | 'failed' | 'cancelled' | 'budget' | 'interrupted'

/**
 * What a child run hands back: the delegate tool result body, the payload of
 * `subagent.end`, and what a workflow's `agent()` resolves with.
 */
export interface MemberResult {
  readonly status: MemberResultStatus
  /** The member's last assistant text (the prefix when interrupted). */
  readonly text: string
  /** Versions the member produced with `present` during the run, in order. */
  readonly deliverables: readonly DeliverableVersionRef[]
  readonly usage: LLMUsage
  readonly requestCount: number
  /** Present unless `completed`. */
  readonly error?: ErrorInfo
  /**
   * Rework K4 D4: what came of merging the member's own copy of the project
   * back into the project at the end of this run. Absent when the member
   * worked in the project directory itself (read-only, no copy possible).
   */
  readonly merge?: WorkdirMerge
  /**
   * Tool calls of the run that were refused (an approval denied, or the
   * sandbox), one per tool, at most 5: what may have kept the member from
   * finishing its part.
   */
  readonly denied?: readonly MemberDenial[]
}

/** One refused tool call of a member run. */
export interface MemberDenial {
  readonly tool: string
  readonly code: 'approval/denied' | 'sandbox/denied'
}

/** Rework K4 D4: directory below the OS temp directory that holds members' copies of projects (`<tmp>/nexgent-workdirs/`). */
export const MEMBER_WORKDIRS_DIR = 'nexgent-workdirs'

/** Rework K4 D4: a file that both the project and a member's copy changed and that could not be merged line by line. */
export interface WorkdirConflict {
  /** Project-relative, `/`-separated. */
  readonly path: string
  /**
   * `both-changed`: both sides changed the file differently (overlapping
   * lines, or not text); `deleted-in-project`: the member changed a file the
   * project deleted; `deleted-by-member`: the member deleted a file the
   * project changed. The project keeps its version in every case.
   */
  readonly kind: 'both-changed' | 'deleted-in-project' | 'deleted-by-member'
  /** Absolute path of the member's version, kept outside the project for the parent to read (absent when the member deleted the file). */
  readonly copy?: string
}

/** Rework K4 D4: the result of merging a member's copy back into the project. */
export interface WorkdirMerge {
  /** Files the member changed that now are in the project (written, or deleted), sorted. */
  readonly applied: readonly string[]
  /** Of {@link applied}: files both sides changed, merged line by line without overlap. */
  readonly merged: readonly string[]
  /** Files left as the project has them, with the member's version kept aside. */
  readonly conflicts: readonly WorkdirConflict[]
}

/** Rework K4 D4: the line a parent reads about a member's merge, or none when nothing happened. */
export function renderWorkdirMerge(merge: WorkdirMerge | undefined): string[] {
  if (merge === undefined || (merge.applied.length === 0 && merge.conflicts.length === 0)) return []
  const lines: string[] = []
  const shown = (paths: readonly string[]) => paths.length <= 20 ? paths.join(', ') : `${paths.slice(0, 20).join(', ')} and ${paths.length - 20} more`
  if (merge.applied.length > 0) {
    lines.push(`Merged into the project: ${shown(merge.applied)}${merge.merged.length > 0 ? ` (combined with other changes: ${shown(merge.merged)})` : ''}.`)
  }
  if (merge.conflicts.length > 0) {
    lines.push('Conflicts (the project kept its version; resolve them yourself):')
    for (const conflict of merge.conflicts) {
      const what = conflict.kind === 'both-changed'
        ? 'changed in the project and by the member'
        : conflict.kind === 'deleted-in-project' ? 'deleted in the project, changed by the member' : 'changed in the project, deleted by the member'
      lines.push(`- ${conflict.path}: ${what}${conflict.copy === undefined ? '' : `; the member's version is at ${conflict.copy}`}`)
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

/** A teammate's roster state. */
export type TeamMemberStatus = 'active' | 'idle' | 'stopped'

/** One roster entry (latest `team.member` per `name` wins). */
export interface TeamMember {
  readonly name: string
  /** The teammate's child session. */
  readonly sessionId: string
  readonly status: TeamMemberStatus
  readonly preset?: string
  /** The `spawn_teammate` persona that replaced the preset's, kept so a restart restores it. */
  readonly persona?: string
}

/** Task board status. A task may start only when every `dependsOn` task is `completed`. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** One task board entry (latest `team.task` per `id` wins). */
export interface TeamTask {
  /** Short id assigned by the board (`t1`, `t2`, …). */
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly status: TeamTaskStatus
  /** Member name; `lead` is the main conversation. */
  readonly owner?: string
  readonly dependsOn: readonly string[]
  /** One line written when the task is completed. */
  readonly result?: string
}

/** Name the Lead (main conversation) is addressed by inside a team. */
export const TEAM_LEAD_NAME = 'lead'

/**
 * A mailbox message. Recorded twice under the same `id`: `queued` when sent,
 * `delivered` when injected into the recipient before its next step. On
 * recovery a `queued` message without its `delivered` twin is delivered once.
 */
export interface TeamMessage {
  /** Lowercase uuid v4. */
  readonly id: string
  readonly from: string
  readonly to: string
  readonly text: string
  readonly state: 'queued' | 'delivered'
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/** How a workflow ended. */
export type WorkflowStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** One node of a declarative workflow graph (ported from PR #4 `architecture.ts`). */
export interface ArchitectureNode {
  /** Member name; matches {@link MEMBER_NAME_PATTERN}; unique in the graph. */
  readonly id: string
  readonly prompt: string
  /** Ids this node waits for; their results are passed into its prompt. */
  readonly dependencies: readonly string[]
  readonly preset?: string
  readonly tools?: ToolRestriction
  readonly model?: string
}

/** A declarative workflow graph. */
export interface ArchitectureGraph {
  readonly nodes: readonly ArchitectureNode[]
}

/** `.nexgent/architectures/<sha256>.json`: immutable, content-addressed (hash of the normalized graph). */
export interface ArchitectureFile {
  readonly format: 1
  readonly architecture: ArchitectureGraph
}

/** Directory, relative to the project root, of saved graphs. */
export const PROJECT_ARCHITECTURES_DIR = '.nexgent/architectures'

// ---------------------------------------------------------------------------
// Limits and tool names
// ---------------------------------------------------------------------------

/** Limits every collaboration implementation enforces (ADR 0004). */
export const COLLABORATION_LIMITS = {
  /** Members running at the same time in one task tree (workflow `parallel`, teammates). */
  maxConcurrentMembers: 4,
  /** Child sessions one task tree may create in total. */
  maxMembersPerTask: 16,
  /** Team task board entries. */
  maxTeamTasks: 256,
  /** Undelivered messages per teammate. */
  maxPendingMessagesPerMember: 64,
  /** UTF-8 bytes of one team message. */
  maxMessageBytes: 65_536,
  /** Nodes of one workflow graph. */
  maxGraphNodes: 16,
  /**
   * Rework K4 (audit D10): characters of member replies one tool result
   * shows in total (`delegate`, `workflow`, `wait_teammates`), split evenly
   * between the members it reports and at least
   * {@link COLLABORATION_LIMITS.minMemberReplyChars} each.
   */
  memberRepliesShownChars: 20_000,
  minMemberReplyChars: 1_500,
} as const

/**
 * Rework K4 (audit D10): a member's reply as a tool result shows it, cut to
 * `max` characters with a note saying how much was left out and how to get
 * the rest (continue the member with `delegate`, or read the files it wrote).
 */
export function memberReplyExcerpt(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters of this reply not shown; ask the member for a specific part with delegate continue, or read the files it wrote]`
}

/** Rework K4 (audit D10): the per-member share of {@link COLLABORATION_LIMITS.memberRepliesShownChars} when a result reports `members` replies. */
export function memberReplyShare(members: number): number {
  return Math.max(COLLABORATION_LIMITS.minMemberReplyChars, Math.floor(COLLABORATION_LIMITS.memberRepliesShownChars / Math.max(1, members)))
}

/**
 * Collaboration tools hidden from every child session: the tools that start
 * members (depth 1; the teammate tools were removed 2026-10-20). Step 4 adds the capability tools:
 * members cannot draft, try or propose components (ADR 0005). Step 5 adds
 * the improvement tools: only an improvement job's diagnose session gets
 * them, never a member (ADR 0006). Step 6 adds the meta-job tools (ADR 0008).
 */
export const MEMBER_DENIED_TOOLS = [
  'delegate',
  'workflow',
  'organize',
  'start_thread',
  'message_thread',
  'read_thread',
  'list_threads',
  'capability_draft',
  'capability_try',
  'capability_propose',
  'improve_read_session',
  'improve_read_ledger',
  'improve_list_feedback',
  'improve_report_diagnosis',
  'improve_list_jobs',
  'improve_read_job',
  'improve_report_meta_diagnosis',
  'improve_read_improver',
  'improve_propose_change',
] as const

