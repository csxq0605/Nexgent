/**
 * JSON Schema of the step-4 capability files: bundle manifests, component
 * entry files, activation revisions, decisions, and task snapshots /
 * checks. Published as `schema/capabilities.v1.schema.json`
 * (one document; validate a file against `$defs/<name>`, see
 * {@link CAPABILITY_FILE_DEFS}); a test keeps the file identical to this object.
 * The shared evaluator has no `maximum` or `maxItems`: upper bounds
 * (`CAPABILITY_LIMITS`) are enforced by the writers and `assertCapabilityManifest`.
 *
 * They live here, next to the session and ledger schemas, so every
 * persisted format shares one evaluator; the writers are
 * `@nexgent/capabilities` and the kernel. Normative text:
 * `docs/spec/data-formats.md` §`CapabilityBundle` 清单, §采用历史,
 * §任务快照与检查. Type mirror: `packages/kernel/src/contracts/capabilities.ts`.
 */
import {
  ACTIVATION_TRIGGERS,
  CAPABILITY_COMPONENT_KINDS,
  CAPABILITY_LIMITS,
  COMPONENT_FILE_PATTERN,
  COMPONENT_NAME_PATTERN,
  DECISION_OUTCOMES,
  DECISION_REASONS,
  isJsonValue,
  TASK_CHECK_NAMES,
  type JsonObject,
} from '@nexgent/kernel'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'

/** `baseline` or a lowercase hex SHA-256 (also used by the session and ledger schemas). */
export const CAPABILITY_VERSION_SCHEMA: JsonObject = { type: 'string', pattern: '^(?:baseline|[a-f0-9]{64})$' }

/** The file kinds this schema covers, and their `$defs` keys. */
export const CAPABILITY_FILE_DEFS = {
  manifest: 'capabilityManifest',
  functionModule: 'functionModuleSpec',
  plugin: 'pluginSpec',
  contextPolicy: 'contextPolicySpec',
  teamTemplate: 'teamTemplateSpec',
  activationRevision: 'activationRevision',
  decision: 'capabilityDecision',
  snapshotTree: 'snapshotTree',
  taskSnapshot: 'taskSnapshotRecord',
  taskChecks: 'taskChecksRecord',
} as const

/** A file kind of {@link CAPABILITY_FILE_DEFS}. */
export type CapabilityFileKind = keyof typeof CAPABILITY_FILE_DEFS

const COMPONENT_NAME = COMPONENT_NAME_PATTERN.source
const COMPONENT_FILE = COMPONENT_FILE_PATTERN.source
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
/** A string of at most `n` characters (the evaluator has no `maxLength`). */
const bounded = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{0,${n}}$` })
const boundedNonEmpty = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{1,${n}}$` })
const nonNegativeInteger: JsonObject = { type: 'integer', minimum: 0 }

/** The capability file schema (draft 2020-12). */
export const capabilitiesSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/capabilities.v1.schema.json',
  title: 'Nexgent capability files v1',
  description: 'Files under .nexgent/capabilities/ and .nexgent/snapshots/; validate against $defs/<name>. See docs/spec/data-formats.md.',
  $defs: {
    timestamp: COMMON_DEFS.timestamp as JsonObject,
    nonEmptyString: COMMON_DEFS.nonEmptyString as JsonObject,
    positiveInteger: COMMON_DEFS.positiveInteger as JsonObject,
    usageCount: COMMON_DEFS.usageCount as JsonObject,
    usage: COMMON_DEFS.usage as JsonObject,
    jsonValue: COMMON_DEFS.jsonValue as JsonObject,
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    uuid: { type: 'string', pattern: UUID },
    capabilityVersion: CAPABILITY_VERSION_SCHEMA,
    componentKind: { enum: [...CAPABILITY_COMPONENT_KINDS] },
    componentName: { type: 'string', pattern: COMPONENT_NAME },
    componentRef: closedObject({ kind: ref('componentKind'), name: ref('componentName') }, ['kind', 'name']),
    capabilityFile: closedObject(
      {
        path: { type: 'string', pattern: COMPONENT_FILE },
        sha256: ref('sha256'),
        bytes: nonNegativeInteger,
      },
      ['path', 'sha256', 'bytes'],
    ),
    capabilityComponent: closedObject(
      {
        kind: ref('componentKind'),
        name: ref('componentName'),
        files: { type: 'array', minItems: 1, items: ref('capabilityFile') },
      },
      ['kind', 'name', 'files'],
    ),
    capabilityManifest: closedObject(
      {
        formatVersion: { const: 1 },
        components: { type: 'array', items: ref('capabilityComponent') },
      },
      ['formatVersion', 'components'],
    ),
    toolEffectNoExecute: { enum: ['read', 'write', 'network'] },
    functionSpec: closedObject(
      {
        name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' },
        description: ref('nonEmptyString'),
        inputSchema: { type: 'object' },
        effects: { type: 'array', items: ref('toolEffectNoExecute') },
      },
      ['name', 'description', 'inputSchema', 'effects'],
    ),
    moduleEntry: { type: 'string', pattern: '^(?![./])(?!.*(?:^|/)\\.{1,2}(?:/|$))[^\\\\:]+\\.mjs$' },
    functionModuleSpec: closedObject(
      {
        formatVersion: { const: 1 },
        name: ref('componentName'),
        description: ref('nonEmptyString'),
        entry: ref('moduleEntry'),
        functions: { type: 'array', minItems: 1, items: ref('functionSpec') },
      },
      ['formatVersion', 'name', 'description', 'functions'],
    ),
    pluginSpec: closedObject(
      {
        formatVersion: { const: 1 },
        name: ref('componentName'),
        description: ref('nonEmptyString'),
        entry: ref('moduleEntry'),
        permissions: ref('nonEmptyString'),
        tools: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' } },
      },
      ['formatVersion', 'name', 'description', 'permissions'],
    ),
    // Closed: approvals, costCaps, sandboxMode, capabilities and gate settings have no place here (H13).
    contextPolicySpec: closedObject(
      {
        formatVersion: { const: 1 },
        name: ref('componentName'),
        description: ref('nonEmptyString'),
        instructions: boundedNonEmpty(CAPABILITY_LIMITS.maxInstructionBytes),
        personaSuffix: boundedNonEmpty(CAPABILITY_LIMITS.maxPersonaSuffixBytes),
        compaction: closedObject(
          {
            thresholdTokens: { type: 'integer', minimum: 10_000 },
            keepRecentTurns: { enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          },
          [],
        ),
      },
      ['formatVersion', 'name', 'description'],
    ),
    teamTemplateMember: closedObject(
      {
        name: { type: 'string', pattern: '^(?!lead$)[a-z][a-z0-9-]{0,31}$' },
        task: ref('nonEmptyString'),
        preset: ref('nonEmptyString'),
        persona: ref('nonEmptyString'),
      },
      ['name', 'task'],
    ),
    teamTemplateSpec: closedObject(
      {
        formatVersion: { const: 1 },
        name: ref('componentName'),
        description: ref('nonEmptyString'),
        members: { type: 'array', minItems: 1, items: ref('teamTemplateMember') },
      },
      ['formatVersion', 'name', 'description', 'members'],
    ),
    activationRevision: closedObject(
      {
        format: { const: 1 },
        revision: ref('positiveInteger'),
        previous: { anyOf: [ref('sha256'), { type: 'null' }] },
        from: ref('capabilityVersion'),
        version: ref('capabilityVersion'),
        type: { enum: ['adopt', 'rollback'] },
        trigger: { enum: [...ACTIVATION_TRIGGERS] },
        decisionId: ref('uuid'),
        committedAt: ref('timestamp'),
      },
      ['format', 'revision', 'previous', 'from', 'version', 'type', 'trigger', 'decisionId', 'committedAt'],
    ),
    taskCheck: closedObject(
      { name: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' }, target: { type: 'string' } },
      ['name', 'passed'],
    ),
    portablePath: { type: 'string', minLength: 1, pattern: '^[^\\\\]+$' },
    taskCheckSpec: {
      oneOf: [
        closedObject({ id: ref('nonEmptyString'), name: { const: 'file-exists' }, path: ref('portablePath') }, ['id', 'name', 'path']),
        closedObject(
          { id: ref('nonEmptyString'), name: { const: 'parses' }, path: ref('portablePath'), format: { enum: ['json', 'csv', 'xlsx'] } },
          ['id', 'name', 'path', 'format'],
        ),
        closedObject(
          { id: ref('nonEmptyString'), name: { const: 'test-command' }, command: ref('nonEmptyString'), shell: { enum: ['bash', 'pwsh'] } },
          ['id', 'name', 'command', 'shell'],
        ),
      ],
    },
    taskCheckName: { enum: [...TASK_CHECK_NAMES] },
    capabilityDecision: closedObject(
      {
        formatVersion: { const: 1 },
        id: ref('uuid'),
        outcome: { enum: [...DECISION_OUTCOMES] },
        reason: { enum: [...DECISION_REASONS] },
        trigger: { enum: [...ACTIVATION_TRIGGERS] },
        decidedAt: ref('timestamp'),
        fromVersion: ref('capabilityVersion'),
        toVersion: ref('capabilityVersion'),
        revision: ref('positiveInteger'),
        detail: bounded(CAPABILITY_LIMITS.maxReasonChars),
      },
      ['formatVersion', 'id', 'outcome', 'reason', 'trigger', 'decidedAt', 'fromVersion', 'toVersion', 'detail'],
    ),
    snapshotFile: closedObject(
      { path: ref('portablePath'), sha256: ref('sha256'), bytes: nonNegativeInteger, executable: { const: true } },
      ['path', 'sha256', 'bytes'],
    ),
    snapshotTree: closedObject(
      { formatVersion: { const: 1 }, files: { type: 'array', items: ref('snapshotFile') } },
      ['formatVersion', 'files'],
    ),
    taskSnapshotRecord: closedObject(
      {
        formatVersion: { const: 1 },
        taskId: ref('nonEmptyString'),
        turn: ref('positiveInteger'),
        sessionId: ref('nonEmptyString'),
        takenAt: ref('timestamp'),
        tree: { anyOf: [ref('sha256'), { type: 'null' }] },
        omitted: closedObject({ reason: { const: 'too-large' }, bytes: nonNegativeInteger }, ['reason', 'bytes']),
        capabilityVersion: ref('capabilityVersion'),
      },
      ['formatVersion', 'taskId', 'sessionId', 'takenAt', 'tree', 'capabilityVersion'],
    ),
    taskChecksRecord: closedObject(
      {
        formatVersion: { const: 1 },
        taskId: ref('nonEmptyString'),
        turn: ref('positiveInteger'),
        sessionId: ref('nonEmptyString'),
        checkedAt: ref('timestamp'),
        specs: { type: 'array', items: ref('taskCheckSpec') },
        results: { type: 'array', items: ref('taskCheck') },
      },
      ['formatVersion', 'taskId', 'sessionId', 'checkedAt', 'specs', 'results'],
    ),
  },
}

const DEFS = capabilitiesSchema.$defs as Record<string, JsonObject>

/** Validate one value against a capability file kind; empty = valid. */
export function validateCapabilityFile(kind: CapabilityFileKind, value: unknown, options?: EvaluateOptions): SchemaIssue[] {
  const schema = DEFS[CAPABILITY_FILE_DEFS[kind]]
  if (schema === undefined) throw new Error(`missing capability schema def for ${kind}`)
  if (!isJsonValue(value)) return [{ path: '/', message: 'not a JSON-safe value' }]
  return evaluateSchema(capabilitiesSchema, schema, value, options)
}
