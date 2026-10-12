/**
 * Model-facing definitions of the step-4 capability tools
 * (`@nexgent/capabilities`): names, input schemas, effects and approval are
 * frozen here so the implementation, the scripted-provider scenarios and
 * `accept-step4` agree. Descriptions may be reworded by the implementing
 * package.
 *
 * The draft area (`.nexgent/capabilities/drafts/<sessionId>/`) is written by
 * the host on the model's behalf; the model's ordinary file tools can read
 * and write none of `.nexgent/capabilities/` (`permissions.md` §能力包组件的执行边界).
 * Members cannot see these tools (`MEMBER_DENIED_TOOLS`).
 */
import { CAPABILITY_COMPONENT_KINDS, CAPABILITY_LIMITS, type CapabilityComponentKind } from './capabilities.js'
import type { JsonSchema } from './json.js'
import type { Step2ToolSpec } from './step2-tools.js'

/** Fixed facts of a step-4 tool (same shape as step 2's). */
export type Step4ToolSpec = Step2ToolSpec

const kind: JsonSchema = { enum: [...CAPABILITY_COMPONENT_KINDS], description: 'Component kind.' }
const name: JsonSchema = { type: 'string', minLength: 1, maxLength: 64, description: 'Lowercase name, letters, digits and dashes, starting with a letter.' }

/**
 * `capability_draft`: create or change one component in this session's
 * draft area. `files` are written (created or replaced) relative to the
 * component directory; `remove` deletes files. The kind's entry file must
 * exist afterwards.
 */
export const CAPABILITY_DRAFT_TOOL: Step4ToolSpec = {
  name: 'capability_draft',
  effects: ['write'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'name'],
    properties: {
      kind,
      name,
      files: {
        type: 'array',
        maxItems: CAPABILITY_LIMITS.maxFilesPerComponent,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', minLength: 1, description: 'Relative to the component directory, e.g. SKILL.md or index.mjs.' },
            content: { type: 'string', description: 'UTF-8 text of the whole file.' },
          },
        },
      },
      remove: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Component-relative files to delete.' },
    },
  },
}

/** Input of {@link CAPABILITY_DRAFT_TOOL}. */
export interface CapabilityDraftToolInput {
  readonly kind: CapabilityComponentKind
  readonly name: string
  readonly files?: readonly { readonly path: string; readonly content: string }[]
  readonly remove?: readonly string[]
}

/**
 * `capability_try`: load the current draft of one component into this
 * session only (a skill joins this session's skill list, a function module's
 * functions become this session's tools, a preset / template / graph becomes
 * usable by this session's collaboration tools, a context policy applies from
 * the next request). Trying a `plugin` runs its code in the host process, so
 * the tool asks the user first with an `always`-class approval, whatever the
 * sandbox mode (`permissions.md` §插件安装审批).
 */
export const CAPABILITY_TRY_TOOL: Step4ToolSpec = {
  name: 'capability_try',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'name'],
    properties: { kind, name },
  },
}

/** Input of {@link CAPABILITY_TRY_TOOL}. */
export interface CapabilityTryToolInput {
  readonly kind: CapabilityComponentKind
  readonly name: string
}

/**
 * `capability_propose`: submit tried components as one candidate. The host
 * accepts only components that this session used successfully at least once
 * after trying them (decision 2) and refuses the call otherwise; an accepted
 * candidate is gated after the task ends.
 */
export const CAPABILITY_PROPOSE_TOOL: Step4ToolSpec = {
  name: 'capability_propose',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['components'],
    properties: {
      components: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        items: { type: 'object', additionalProperties: false, required: ['kind', 'name'], properties: { kind, name } },
      },
      summary: { type: 'string', minLength: 1, maxLength: 500, description: 'One line: what the components improve and for which tasks.' },
    },
  },
}

/** Input of {@link CAPABILITY_PROPOSE_TOOL}. */
export interface CapabilityProposeToolInput {
  readonly components: readonly { readonly kind: CapabilityComponentKind; readonly name: string }[]
  readonly summary?: string
}

/** Every step-4 tool spec, in the order above. */
export const STEP4_TOOLS: readonly Step4ToolSpec[] = [CAPABILITY_DRAFT_TOOL, CAPABILITY_TRY_TOOL, CAPABILITY_PROPOSE_TOOL]
