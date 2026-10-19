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
}

/** Step 3: an organization as the library keeps it (the roles' parts are task-specific and not kept). */
export interface OrganizationShape {
  readonly name: OrganizationName
  readonly roles: readonly OrganizationRole[]
}

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
}

/** Step 3: what the library says about one class of similar tasks. */
export interface OrganizationClassSummary {
  readonly classId: string
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
}
