/**
 * New direction step 2: how a task is organized. Nexgent decides per root
 * turn whether members help (`OrganizationDecision`, recorded on
 * `turn.start.organization`); when they do, the model starts them with one
 * `organize` call naming an organization (roles, their parts, who waits for
 * whom), and calls it again with a reason when the organization makes no
 * progress (an `organization` record each time). Role kinds and the
 * organizations are generic, never tied to a kind of task.
 */
import type { JsonSchema } from './json.js'
import type { Step2ToolSpec } from './step2-tools.js'

/** What a role does. */
export const ORGANIZATION_ROLE_KINDS = ['plan', 'explore', 'implement', 'test', 'review'] as const
export type OrganizationRoleKind = typeof ORGANIZATION_ROLE_KINDS[number]

/**
 * The organizations the model may choose from (`solo` is chosen by Nexgent
 * only): you do the work and a checker verifies it; a planner splits the
 * work, implementers build parts in parallel and a reviewer checks; explorers
 * read in parallel, then the work is built; or any other arrangement.
 */
export const ORGANIZATION_NAMES = ['lead-checker', 'plan-build-review', 'explore-then-build', 'custom'] as const
export type OrganizationName = typeof ORGANIZATION_NAMES[number]

/** At most this many roles in one organization. */
export const MAX_ORGANIZATION_ROLES = 6

/** Whether members help with a root turn, and why Nexgent decided so. */
export interface OrganizationDecision {
  readonly decision: 'solo' | 'team'
  /**
   * `size`: the task is small, so it is done without members; `control`: a
   * task that could use members is done alone for comparison (1 in 5 by
   * default); `default`: members may help; `memory` (step 3): what worked
   * on similar tasks decided it (`OrganizationMemory`).
   */
  readonly chosenBy: 'size' | 'control' | 'default' | 'memory'
  /** Step 3: the organization suggested from similar tasks, when there was one. */
  readonly suggested?: OrganizationName
  /** Coordinator: the one change to the organization this team turn tries, or the verdict on the last one. */
  readonly change?: OrganizationChangeNote
}

/** Step 3: what `chosenBy` may be. */
export const ORGANIZATION_CHOSEN_BY = ['size', 'control', 'default', 'memory'] as const

/** One role of an organization as recorded. */
export interface OrganizationRole {
  /** The member's name (`MEMBER_NAME_PATTERN`). */
  readonly name: string
  readonly kind: OrganizationRoleKind
  /** Roles whose results this one waits for. */
  readonly after: readonly string[]
}

/** `organize` input. */
export interface OrganizeToolInput {
  readonly organization: OrganizationName
  /** Required when the turn already ran an organization: why it is being changed. */
  readonly reason?: string
  readonly roles: readonly {
    readonly name: string
    readonly kind: OrganizationRoleKind
    /** The role's part: goal, inputs, what to produce and where. */
    readonly task: string
    readonly after?: readonly string[]
  }[]
}

const memberName: JsonSchema = { type: 'string', minLength: 1, maxLength: 32, description: 'Lowercase name, letters, digits and dashes, starting with a letter.' }

/** `organize`: start members in the given organization and wait for all of them (foreground). */
export const ORGANIZE_TOOL: Step2ToolSpec = {
  name: 'organize',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['organization', 'roles'],
    properties: {
      organization: { type: 'string', enum: [...ORGANIZATION_NAMES] },
      reason: { type: 'string', minLength: 1, description: 'Why the previous organization of this task is being changed.' },
      roles: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ORGANIZATION_ROLES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'kind', 'task'],
          properties: {
            name: memberName,
            kind: { type: 'string', enum: [...ORGANIZATION_ROLE_KINDS] },
            task: { type: 'string', minLength: 1 },
            after: { type: 'array', items: memberName, description: 'Roles whose results this one waits for.' },
          },
        },
      },
    },
  },
}

/** What one turn's organization came to, for `task.outcome.organization` (step 3 compares organizations with it). */
export interface OrganizationUse {
  readonly decision: OrganizationDecision['decision']
  readonly chosenBy: OrganizationDecision['chosenBy']
  /** The last organization the turn ran; absent when it ran none. */
  readonly name?: OrganizationName
  /** Roles of that organization. */
  readonly roles?: number
  /** How many times the turn changed its organization. */
  readonly reorganizations: number
  /** Messages the user sent while the turn ran (corrections). */
  readonly corrections: number
  /** Coordinator: the change this turn's decision carried ({@link OrganizationDecision.change}). */
  readonly change?: OrganizationChangeNote
}

/** Step 3: an organization as the library keeps it (the roles' parts are task-specific and not kept). */
export interface OrganizationShape {
  readonly name: OrganizationName
  readonly roles: readonly OrganizationRole[]
}

/**
 * Which layer a run organizes. `coordinator`: the coordinator's turn, whose
 * organization is how the task was split into threads (how many, which part
 * each, the handoffs). Absent: a turn of a thread or of any other
 * conversation, whose organization is its own members' division of work.
 * The library classes, compares and reflects on the two separately.
 */
export type OrganizationLevel = 'coordinator'

/**
 * Step 3: what one root turn came to, as the organization library records
 * it. Only deterministic signals: the checks, the user's corrections while
 * it ran, rework (a later feedback turn asking for changes) and the cost.
 */
export interface OrganizationRun {
  readonly id: string
  readonly at: string
  /** The class of similar tasks the turn was put in. */
  readonly classId: string
  /** The task text's similarity terms (at most 16). */
  readonly key: readonly string[]
  readonly sessionId: string
  readonly turn: number
  /** The layer the run organizes ({@link OrganizationLevel}); absent: members. */
  readonly level?: OrganizationLevel
  readonly decision: OrganizationDecision['decision']
  /** The turn was done alone (or by a team) for comparison, against what was preferred. */
  readonly control: boolean
  /** The last organization the turn ran. */
  readonly organization?: OrganizationShape
  readonly reorganizations: number
  readonly corrections: number
  /** Passed and total deterministic checks; absent when none ran. */
  readonly checks?: { readonly passed: number; readonly total: number }
  /** The turn ended `completed`. */
  readonly completed: boolean
  /** The turn's cost in USD over the whole task tree (estimated when usage was). */
  readonly usd: number
  /**
   * What the turn did, for classing tasks worded differently: `ext:<ext>`
   * of the files it added or changed, `tool:<name>` of the tools it called
   * (coordination tools left out), `check:<name>` of its checks. Sorted.
   */
  readonly traits?: readonly string[]
  /** Absolute project root. */
  readonly projectRoot?: string
  /** Files the turn presented as its result and did not delete (project-relative). */
  readonly outputs?: readonly string[]
  /** Files the turn deleted (project-relative). */
  readonly deleted?: readonly string[]
  /** Coordinator: what each part of the organization cost, how long it ran, how it failed or waited. */
  readonly profile?: OrganizationProfile
  /** Coordinator: the {@link OrganizationChange} this turn tried (its id). */
  readonly change?: string
  /**
   * Coordinator step two: threads the turn started had not all ended when it
   * was recorded; `profile` is replaced (and the class reflected on) once
   * they have (`OrganizationMemory.noteProfile`).
   */
  readonly waiting?: true
}

// ---------------------------------------------------------------------------
// Coordinator: reflecting on the organization after every task
// ---------------------------------------------------------------------------

/** What a measured part is: the coordinator (the root conversation), a role of an organization, a member started with `delegate`, or a thread. */
export type OrganizationPartKind = OrganizationRoleKind | 'coordinator' | 'member' | 'thread'

/**
 * Coordinator: one part of how a task was organized, measured from the run
 * records after the task. Cost is split by each part's share of the task's
 * model cost; time is the part's own wall time.
 */
export interface OrganizationPart {
  /** `coordinator`, or the member's name. */
  readonly name: string
  readonly kind: OrganizationPartKind
  /** Model tokens of the part (input, output and cache). */
  readonly tokens: number
  /** Share of the task's model cost, 0–1. */
  readonly share: number
  /** Estimated USD: the task's cost times {@link share}. */
  readonly usd: number
  /** Wall time the part worked, in ms (the coordinator's excludes {@link idleMs}). */
  readonly ms: number
  /**
   * Failures: failed tool calls, a run that did not complete, refused calls
   * and merge conflicts (members); failed tool calls (coordinator).
   */
  readonly failures: number
  /** Retries: a member's extra runs in the task; the coordinator's automatic check retries. */
  readonly retries: number
  /** Idle wait in ms: a member ready but waiting for a free slot; the coordinator waiting for members. */
  readonly idleMs: number
  /** Wasted work: everything the part wrote was later rewritten whole or deleted in the same task. */
  readonly wasted: boolean
  /** With {@link wasted}: who rewrote it (`coordinator` or a member's name). */
  readonly redoneBy?: string
}

/** Coordinator: the measured parts of one task. */
export interface OrganizationProfile {
  /** The task's cost in USD (the task tree). */
  readonly usd: number
  /** Wall time of the turn in ms. */
  readonly ms: number
  readonly tokens: number
  /** The coordinator first, then members in start order. */
  readonly parts: readonly OrganizationPart[]
}

/** What makes a part the hottest spot of a task. */
export const ORGANIZATION_HOTSPOT_CAUSES = ['failures', 'wasted', 'cost', 'time', 'idle'] as const
export type OrganizationHotspotCause = typeof ORGANIZATION_HOTSPOT_CAUSES[number]

/** Coordinator: the one part a task's reflection picked, and why. */
export interface OrganizationHotspot {
  readonly part: string
  readonly kind: OrganizationPartKind
  readonly cause: OrganizationHotspotCause
  /**
   * The measured value: failures plus retries (`failures`), 1 (`wasted`),
   * share of the cost (`cost`) or of the task's time (`time`), idle time
   * over the part's own time (`idle`).
   */
  readonly value: number
}

/**
 * The fixed changes the coordinator chooses from: `narrow-reading` (the role
 * reads only what the task touches), `split` (its part goes to two members
 * that run at the same time; for the coordinator, its own work goes to a
 * member), `merge` (fewer members: the part joins the one that redid it or
 * waited for it), `parallelize` (a part that waited for another of the same
 * kind runs beside it), `sequence` (parts that collided on the same files run
 * one after another), `full-handoff` (the role gets the full results of the
 * roles before it, not a summary).
 */
export const ORGANIZATION_CHANGE_ACTIONS = ['narrow-reading', 'split', 'merge', 'parallelize', 'sequence', 'full-handoff'] as const
export type OrganizationChangeAction = typeof ORGANIZATION_CHANGE_ACTIONS[number]

/** Coordinator: one change to a class's organization, tried on the next similar team tasks. */
export interface OrganizationChange {
  /** Lowercase uuid v4. */
  readonly id: string
  readonly classId: string
  readonly action: OrganizationChangeAction
  /** The hotspot it targets (the part's kind; roles are matched by kind across tasks). */
  readonly target: OrganizationHotspot
  /** Median of the target value over the class's team runs before the change (the bar it must beat by 20 %). */
  readonly baseline: number
  /** Median task cost of those runs in USD (the whole may not get worse). */
  readonly baselineUsd: number
  /** The run whose reflection found the hotspot. */
  readonly runId: string
  /** Model-facing instruction added to the organization section of the next similar team tasks. */
  readonly instruction: string
  /**
   * Coordinator step three: who picked {@link action} among the changes that
   * fit the hotspot. `model`: a model read the hot part's run records, judged
   * the cause and picked one with a reason; `rule`: the fixed order (no model,
   * or its call failed or gave no valid choice). Absent on older lines: `rule`.
   */
  readonly chosenBy?: OrganizationChangeChooser
  /** With `chosenBy: model`: the cause it found in the records (at most {@link ORGANIZATION_REASON_CHARS} characters). */
  readonly cause?: string
  /** With `chosenBy: model`: why this change and not the others (at most {@link ORGANIZATION_REASON_CHARS} characters). */
  readonly reason?: string
}

/** Who picked an organization change. */
export type OrganizationChangeChooser = 'model' | 'rule'

/** Characters of a model-written cause or reason of an organization change. */
export const ORGANIZATION_REASON_CHARS = 400

/**
 * Coordinator step three: the opening words of the system prompt of the
 * background request that picks an organization change (`purpose:
 * auxiliary`), so a host or a scripted model can tell it from a task's requests.
 */
export const ORGANIZATION_REFLECTION_LEAD = 'You review how an AI agent organized one finished task'

/**
 * How a change ended: kept (two similar tasks improved it, nothing got
 * worse), reverted (tried and did not work: not given again for that kind
 * of part and cause) or unfollowed (the task did not do what the change
 * said, so it was no trial: dropped, and it may be given again).
 */
export type OrganizationChangeVerdict = 'kept' | 'reverted' | 'unfollowed'

/**
 * Coordinator: the one line the user sees on a team card about the
 * organization. `trying`: this task runs a change found on the last similar
 * one; `kept` / `reverted`: the verdict on the previous change (with the
 * change this task tries next, when there is one).
 */
export interface OrganizationChangeNote {
  readonly status: 'trying' | 'kept' | 'reverted'
  readonly action: OrganizationChangeAction
  readonly target: OrganizationHotspot
  /** With `kept` / `reverted`: the change tried now, if any. */
  readonly next?: { readonly action: OrganizationChangeAction; readonly target: OrganizationHotspot }
}

/** Step 3: what the library says about one class of similar tasks. */
export interface OrganizationClassSummary {
  readonly classId: string
  /** `coordinator`: a class of the coordinator's splits into threads (absent: members' divisions of work). */
  readonly level?: OrganizationLevel
  /** The class's commonest terms (at most 6), to name it. */
  readonly keywords: readonly string[]
  readonly soloRuns: number
  readonly teamRuns: number
  /**
   * `comparing`: too few runs, or no difference yet; `team-better` /
   * `solo-better`: the lower end of one side's interval is above the other
   * side's rate.
   */
  readonly verdict: 'comparing' | 'team-better' | 'solo-better'
  /** The organization the class's team runs use most. */
  readonly organization?: OrganizationName
  /** Share of runs that went well (no failed check, no correction, no rework), 0–1. */
  readonly soloGood?: number
  readonly teamGood?: number
  /** Mean team cost over mean solo cost, minus 1 (0.3 is 30 % more). */
  readonly costChange?: number
  /**
   * Coordinator: the class's latest team runs against its first ones
   * (median of up to 3 each, once there are at least 4 team runs with a
   * profile): cost and time change (−0.3 is 30 % less), and whether the share
   * of runs that went well held.
   */
  readonly sinceStart?: { readonly costChange: number; readonly timeChange: number; readonly qualityHeld: boolean }
  /** Coordinator: changes kept and reverted in the class. */
  readonly changesKept?: number
  readonly changesReverted?: number
}
