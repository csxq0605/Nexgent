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
   * default); `default`: members may help.
   */
  readonly chosenBy: 'size' | 'control' | 'default'
}

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
