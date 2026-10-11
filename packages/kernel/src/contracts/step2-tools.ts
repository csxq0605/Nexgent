/**
 * Model-facing definitions of the step-2 tools. Names and input schemas are frozen here so that the
 * packages implementing them (`@nexgent/tasking` for `present`,
 * `@nexgent/skill` for `load_skill` and `read_document`), the scripted
 * provider scenarios and `accept-step2` agree. Descriptions may be reworded by
 * the implementing package; names, schemas and effects may not.
 */
import type { JsonSchema } from './json.js'
import type { ToolApproval, ToolEffect } from './tools.js'

/** Fixed facts of a step-2 tool. */
export interface Step2ToolSpec {
  readonly name: string
  readonly inputSchema: JsonSchema
  readonly effects: readonly ToolEffect[]
  readonly approval: ToolApproval
  /** Step 3: copied into {@link ToolDefinition.selfSandboxed}. */
  readonly selfSandboxed?: boolean
}

/** `present`: declare files as a deliverable; the host snapshots them into `.nexgent/outputs/`. */
export const PRESENT_TOOL: Step2ToolSpec = {
  name: 'present',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['paths', 'summary'],
    properties: {
      paths: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'string', minLength: 1 },
        description: 'Project files that make up the deliverable; the first is the primary file.',
      },
      summary: { type: 'string', minLength: 1, description: 'One sentence: what the deliverable is and what changed.' },
      title: { type: 'string', minLength: 1, description: 'Short display name; defaults to the primary file name.' },
      deliverableId: {
        type: 'string',
        minLength: 1,
        description: 'Id of an earlier deliverable this is a new version of (from a previous present result or feedback).',
      },
    },
  },
}

/** Input of {@link PRESENT_TOOL}. */
export interface PresentToolInput {
  readonly paths: readonly string[]
  readonly summary: string
  readonly title?: string
  readonly deliverableId?: string
}

/** `load_skill`: return the full instructions of a listed skill. */
export const LOAD_SKILL_TOOL: Step2ToolSpec = {
  name: 'load_skill',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, description: 'Skill name from the skills list.' } },
  },
}

/** Input of {@link LOAD_SKILL_TOOL}. */
export interface LoadSkillToolInput {
  readonly name: string
}

/** `read_document`: extract text / tables from `.docx`, `.xlsx`, `.pdf` (read-only; works in `read-only` mode). */
export const READ_DOCUMENT_TOOL: Step2ToolSpec = {
  name: 'read_document',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1, description: 'Project path of a .docx, .xlsx or .pdf file (materials included).' },
      sheet: { type: 'string', description: '.xlsx only: sheet name; default all sheets.' },
      maxRows: { type: 'integer', minimum: 1, description: '.xlsx only: rows per sheet; default 500.' },
      pages: { type: 'string', description: '.pdf only: page range like "1-3"; default all.' },
    },
  },
}

/** Input of {@link READ_DOCUMENT_TOOL}. */
export interface ReadDocumentToolInput {
  readonly path: string
  readonly sheet?: string
  readonly maxRows?: number
  readonly pages?: string
}

/** Every step-2 tool spec. */
export const STEP2_TOOLS: readonly Step2ToolSpec[] = [PRESENT_TOOL, LOAD_SKILL_TOOL, READ_DOCUMENT_TOOL]
