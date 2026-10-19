/**
 * Model-facing definitions of the step-3 tools. Names, input schemas,
 * effects and approval policy of the collaboration tools (`@nexgent/subagent`,
 * `@nexgent/team`, `@nexgent/workflow`, `@nexgent/ptc`) are frozen here so the
 * implementing packages, the scripted-provider scenarios and `accept-step3`
 * agree. The capability-migration tools (`web_fetch`, `read_spreadsheet`,
 * `write_spreadsheet`) are frozen by name, effects and approval only; their
 * input schemas belong to `@nexgent/web` and `@nexgent/tool-spreadsheet`.
 * Descriptions may be reworded by the implementing package.
 *
 * Effects describe the tool call itself. A member's own tool calls are
 * checked against the member's sandbox and approval rules one by one, so a
 * tool that starts members declares only `read`.
 */
import type { JsonSchema } from './json.js'
import type { ToolApproval, ToolEffect } from './tools.js'
import type { Step2ToolSpec } from './step2-tools.js'

/** Fixed facts of a step-3 tool (same shape as step 2's). */
export type Step3ToolSpec = Step2ToolSpec

const memberName: JsonSchema = { type: 'string', minLength: 1, maxLength: 32, description: 'Lowercase name, letters, digits and dashes, starting with a letter.' }
const materialIds: JsonSchema = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 }, description: 'Ids of project materials the member should see.' }
const files: JsonSchema = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 }, description: 'Project paths the member should read first.' }
const toolRestriction: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { allow: { type: 'array', items: { type: 'string' } }, deny: { type: 'array', items: { type: 'string' } } },
}

/** `delegate`: run one sub-task in a child session and wait for its result (foreground, one-shot; several in one step run at once). */
export const DELEGATE_TOOL: Step3ToolSpec = {
  name: 'delegate',
  effects: ['read'],
  approval: 'never',
  concurrent: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'task'],
    properties: {
      name: memberName,
      task: { type: 'string', minLength: 1, description: 'Self-contained instructions: goal, inputs, what to produce and where.' },
      mode: { enum: ['fresh', 'fork'], description: 'fresh (default): only this task and the materials; fork: also this conversation so far.' },
      preset: { type: 'string', minLength: 1, description: 'Preset name (built-in or .nexgent/presets/<name>.json).' },
      persona: { type: 'string', minLength: 1, description: 'Ad-hoc persona when no preset fits; cannot widen tools or sandbox.' },
      materialIds,
      files,
      expectedOutput: { type: 'string', minLength: 1, description: 'One sentence: what the member should present.' },
      continue: { type: 'string', minLength: 1, description: 'Member id from an earlier delegate or workflow result: send that member this task as a follow-up; it keeps everything it saw. name must be its name.' },
      maxRequests: { type: 'integer', minimum: 1, maximum: 200, description: 'Most model requests this member may make in this run (the task\'s own cap still applies).' },
    },
  },
}

/** Input of {@link DELEGATE_TOOL}. */
export interface DelegateToolInput {
  readonly name: string
  readonly task: string
  readonly mode?: 'fresh' | 'fork'
  readonly preset?: string
  readonly persona?: string
  readonly materialIds?: readonly string[]
  readonly files?: readonly string[]
  readonly expectedOutput?: string
  /** Rework K4 (audit D6): the child session of an earlier `delegate` or workflow member of this parent, to continue. */
  readonly continue?: string
  /** Rework K4 (audit D11): the member's own request cap for this run ({@link BudgetShare.maxRequests}). */
  readonly maxRequests?: number
}

/** `spawn_teammate`: add a named teammate (a child session) to this turn's team and give it its first task. */
export const SPAWN_TEAMMATE_TOOL: Step3ToolSpec = {
  name: 'spawn_teammate',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'task'],
    properties: {
      name: memberName,
      task: { type: 'string', minLength: 1, description: 'What the teammate should do first.' },
      preset: { type: 'string', minLength: 1 },
      persona: { type: 'string', minLength: 1 },
      materialIds,
      files,
    },
  },
}

/** Input of {@link SPAWN_TEAMMATE_TOOL}. */
export interface SpawnTeammateToolInput {
  readonly name: string
  readonly task: string
  readonly preset?: string
  readonly persona?: string
  readonly materialIds?: readonly string[]
  readonly files?: readonly string[]
}

/** `send_message`: queue a message to a teammate or to `lead`; delivered before the recipient's next step. */
export const SEND_MESSAGE_TOOL: Step3ToolSpec = {
  name: 'send_message',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['to', 'text'],
    properties: {
      to: { type: 'string', minLength: 1, description: 'Teammate name, or lead.' },
      text: { type: 'string', minLength: 1 },
    },
  },
}

/** Input of {@link SEND_MESSAGE_TOOL}. */
export interface SendMessageToolInput {
  readonly to: string
  readonly text: string
}

/**
 * `wait_teammates`: block until the named (default: all active) teammates are
 * idle or stopped, or (default `until: 'mail-or-idle'`, rework K4) until a
 * message for the Lead arrives; returns their results and mail for the Lead.
 */
export const WAIT_TEAMMATES_TOOL: Step3ToolSpec = {
  name: 'wait_teammates',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      names: { type: 'array', items: memberName, description: 'Default: every active teammate.' },
      until: { enum: ['mail-or-idle', 'idle'], description: 'mail-or-idle (default): also return as soon as a teammate sends you a message; idle: only when they have all stopped.' },
    },
  },
}

/** Input of {@link WAIT_TEAMMATES_TOOL}. */
export interface WaitTeammatesToolInput {
  readonly names?: readonly string[]
  readonly until?: 'mail-or-idle' | 'idle'
}

/**
 * `wait_for_message` (teammates only, rework K4, audit D7): wait, without
 * model requests, until a message for this teammate arrives, a named
 * teammate finishes its current run, or the timeout passes.
 */
export const WAIT_FOR_MESSAGE_TOOL: Step3ToolSpec = {
  name: 'wait_for_message',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      teammates: { type: 'array', items: memberName, maxItems: 16, description: 'Also return when one of these teammates finishes its current run.' },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 120.' },
    },
  },
}

/** Input of {@link WAIT_FOR_MESSAGE_TOOL}. */
export interface WaitForMessageToolInput {
  readonly teammates?: readonly string[]
  readonly timeoutSeconds?: number
}

/** `team_task_create`: add a task to the shared board. */
export const TEAM_TASK_CREATE_TOOL: Step3ToolSpec = {
  name: 'team_task_create',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      owner: { type: 'string', minLength: 1, description: 'Teammate name or lead.' },
      dependsOn: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Ids of tasks that must be completed first.' },
    },
  },
}

/** Input of {@link TEAM_TASK_CREATE_TOOL}. */
export interface TeamTaskCreateToolInput {
  readonly title: string
  readonly description?: string
  readonly owner?: string
  readonly dependsOn?: readonly string[]
}

/** `team_task_list`: the board as it stands. */
export const TEAM_TASK_LIST_TOOL: Step3ToolSpec = {
  name: 'team_task_list',
  effects: ['read'],
  approval: 'never',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}

/** `team_task_update`: claim, complete or cancel a task (starting one whose dependencies are open fails). */
export const TEAM_TASK_UPDATE_TOOL: Step3ToolSpec = {
  name: 'team_task_update',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      status: { enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
      owner: { type: 'string', minLength: 1 },
      result: { type: 'string', description: 'One line when completing.' },
    },
  },
}

/** Input of {@link TEAM_TASK_UPDATE_TOOL}. */
export interface TeamTaskUpdateToolInput {
  readonly id: string
  readonly status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  readonly owner?: string
  readonly result?: string
}

/**
 * `workflow`: run exactly one of a JavaScript script (with `agent()`,
 * `parallel()`, `pipeline()`, `phase()`, `log()` and `args`) or a declarative
 * graph (`ArchitectureGraph`), in the foreground.
 */
export const WORKFLOW_TOOL: Step3ToolSpec = {
  name: 'workflow',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1 },
      script: { type: 'string', minLength: 1, description: 'Async JavaScript body; its return value is the workflow result.' },
      graph: {
        type: 'object',
        additionalProperties: false,
        required: ['nodes'],
        properties: {
          nodes: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'prompt', 'dependencies'],
              properties: {
                id: memberName,
                prompt: { type: 'string', minLength: 1 },
                dependencies: { type: 'array', items: { type: 'string', minLength: 1 } },
                preset: { type: 'string', minLength: 1 },
                tools: toolRestriction,
                model: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
      args: { description: 'JSON value passed to the script as `args` (graph: to every node).' },
    },
  },
}

/** Input of {@link WORKFLOW_TOOL}; exactly one of `script` / `graph`. */
export interface WorkflowToolInput {
  readonly title?: string
  readonly script?: string
  readonly graph?: import('./collaboration.js').ArchitectureGraph
  readonly args?: import('./json.js').JsonValue
}

/** `run_code`: run JavaScript in an isolated Node process with host functions (PTC). */
export const RUN_CODE_TOOL: Step3ToolSpec = {
  name: 'run_code',
  effects: ['read', 'write', 'execute'],
  approval: 'never',
  selfSandboxed: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: {
      code: { type: 'string', minLength: 1, description: 'Async JavaScript body; use the documented host functions for files.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Default 60000.' },
    },
  },
}

/** Input of {@link RUN_CODE_TOOL}. */
export interface RunCodeToolInput {
  readonly code: string
  readonly timeoutMs?: number
}

/** Every collaboration and PTC tool spec, in the order above. */
export const STEP3_TOOLS: readonly Step3ToolSpec[] = [
  DELEGATE_TOOL,
  SPAWN_TEAMMATE_TOOL,
  SEND_MESSAGE_TOOL,
  WAIT_TEAMMATES_TOOL,
  WAIT_FOR_MESSAGE_TOOL,
  TEAM_TASK_CREATE_TOOL,
  TEAM_TASK_LIST_TOOL,
  TEAM_TASK_UPDATE_TOOL,
  WORKFLOW_TOOL,
  RUN_CODE_TOOL,
]

/** Names, effects and approval of the capability-migration tools (input schemas belong to their packages). */
export const STEP3_MIGRATED_TOOLS: readonly { readonly name: string; readonly effects: readonly ToolEffect[]; readonly approval: ToolApproval }[] = [
  { name: 'web_fetch', effects: ['network'], approval: 'never' },
  { name: 'read_spreadsheet', effects: ['read'], approval: 'never' },
  { name: 'write_spreadsheet', effects: ['write'], approval: 'never' },
]
