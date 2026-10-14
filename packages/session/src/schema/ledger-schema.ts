/**
 * JSON Schema of the ledger records and their validators.
 *
 * Unlike session records the ledger is an open format: the published schema
 * does not close objects, so a reader accepts unknown optional fields from a
 * newer writer. `JsonlLedger.append` validates with
 * `forbidAdditionalProperties` so nothing outside the declared fields (prompt
 * text, arguments, output, keys) can be written.
 *
 * Normative text: `docs/spec/data-formats.md` §账本记录. Type mirror:
 * `packages/kernel/src/contracts/ledger.ts`.
 */
import {
  ACTIVATION_TRIGGERS,
  CAPABILITY_COMPONENT_KINDS,
  DECISION_OUTCOMES,
  DECISION_REASONS,
  COMPARISON_ARMS,
  IMPROVEMENT_COST_PHASES,
  IMPROVEMENT_JOB_KINDS,
  IMPROVEMENT_PHASES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TRIGGERS,
  IMPROVER_SCOPES,
  IMPROVER_VERSION_PATTERN,
  isJsonValue,
  LEDGER_RECORD_TYPES,
  type JsonObject,
  type LedgerRecordType,
} from '@nexgent/kernel'
import { CAPABILITY_VERSION_SCHEMA } from './capabilities-schema.js'
import { COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'
import type { RecordValidator } from './session-schema.js'

/** `$defs` key of each ledger record type's schema. */
export const LEDGER_RECORD_DEFS: Readonly<Record<LedgerRecordType, string>> = {
  'llm.request.start': 'llmRequestStartRecord',
  'llm.request.end': 'llmRequestEndRecord',
  'tool.call': 'toolCallRecord',
  'task.outcome': 'taskOutcomeRecord',
  'capability.decision': 'capabilityDecisionRecord',
  'improvement.end': 'improvementEndRecord',
}

function record(type: LedgerRecordType, properties: Record<string, JsonObject>, required: readonly string[]): JsonObject {
  return {
    type: 'object',
    required: ['type', 'ts', ...required],
    properties: {
      type: { const: type },
      ts: ref('timestamp'),
      sessionId: ref('nonEmptyString'),
      capabilityVersion: ref('capabilityVersion'),
      memberId: { type: 'string' },
      executionForm: { enum: ['direct', 'delegated', 'team', 'workflow'] },
      taskId: { type: 'string' },
      trialId: { type: 'string' },
      arm: { enum: ['candidate', 'baseline'] },
      improvementId: { type: 'string' },
      improvementPhase: { enum: [...IMPROVEMENT_PHASES] },
      improverVersion: ref('improverVersion'),
      improverScope: { enum: [...IMPROVER_SCOPES] },
      metaJobId: { type: 'string' },
      comparisonArm: { enum: [...COMPARISON_ARMS] },
      ...properties,
    },
  }
}

const requestFields: Record<string, JsonObject> = {
  requestId: ref('nonEmptyString'),
  provider: ref('nonEmptyString'),
  endpoint: { type: 'string' },
  model: { type: 'string' },
}

/** The ledger record schema (draft 2020-12). */
export const ledgerRecordSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/ledger.v1.schema.json',
  title: 'Nexgent ledger v1 record',
  description: 'One line of .nexgent/ledgers/<yyyy-mm>/requests.jsonl. See docs/spec/data-formats.md.',
  oneOf: LEDGER_RECORD_TYPES.map(type => ref(LEDGER_RECORD_DEFS[type])),
  $defs: {
    ...COMMON_DEFS,
    toolCallApproval: {
      type: 'object',
      required: ['required', 'decision'],
      properties: {
        required: { type: 'boolean' },
        decision: { enum: ['allow', 'deny', 'timeout', 'cancel', 'auto'] },
        scope: ref('approvalScope'),
        requestId: { type: 'string' },
      },
    },
    taskCheck: {
      type: 'object',
      required: ['name', 'passed'],
      properties: { name: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' }, target: { type: 'string' } },
    },
    capabilityVersion: CAPABILITY_VERSION_SCHEMA,
    improverVersion: { type: 'string', pattern: IMPROVER_VERSION_PATTERN.source },
    componentUsage: {
      type: 'object',
      required: ['kind', 'name', 'version', 'calls', 'errors'],
      properties: {
        kind: { enum: [...CAPABILITY_COMPONENT_KINDS] },
        name: { type: 'string' },
        version: { anyOf: [ref('capabilityVersion'), { const: 'draft' }] },
        calls: { type: 'integer', minimum: 0 },
        errors: { type: 'integer', minimum: 0 },
      },
    },
    memberCost: {
      type: 'object',
      required: ['memberId', 'name', 'executionForm', 'usage', 'requestCount', 'toolCallCount'],
      properties: {
        memberId: ref('nonEmptyString'),
        name: { type: 'string' },
        executionForm: { enum: ['direct', 'delegated', 'team', 'workflow'] },
        usage: ref('usage'),
        requestCount: { type: 'integer', minimum: 0 },
        toolCallCount: { type: 'integer', minimum: 0 },
      },
    },
    phaseCost: {
      type: 'object',
      required: ['usage', 'requestCount'],
      properties: { usage: ref('usage'), requestCount: { type: 'integer', minimum: 0 } },
    },
    llmRequestStartRecord: record(
      'llm.request.start',
      { ...requestFields, purpose: { enum: ['task', 'auxiliary'] }, thinking: { enum: ['off', 'on'] } },
      ['requestId', 'provider', 'endpoint', 'model', 'purpose', 'thinking'],
    ),
    llmRequestEndRecord: record(
      'llm.request.end',
      {
        ...requestFields,
        status: { enum: ['ok', 'error', 'aborted', 'unknown'] },
        usage: ref('usage'),
        latencyMs: ref('nonNegativeNumber'),
        httpStatus: { type: 'integer' },
        finishReason: ref('finishReason'),
        errorCode: { type: 'string' },
      },
      ['requestId', 'provider', 'endpoint', 'model', 'status', 'usage', 'latencyMs'],
    ),
    toolCallRecord: record(
      'tool.call',
      {
        turn: ref('positiveInteger'),
        callId: { type: 'string' },
        name: { type: 'string' },
        effects: { type: 'array', items: { enum: ['read', 'write', 'execute', 'network'] } },
        approval: ref('toolCallApproval'),
        isError: { type: 'boolean' },
        durationMs: ref('nonNegativeNumber'),
      },
      ['sessionId', 'turn', 'callId', 'name', 'effects', 'approval', 'isError', 'durationMs'],
    ),
    taskOutcomeRecord: record(
      'task.outcome',
      {
        status: { enum: ['completed', 'cancelled', 'failed'] },
        error: ref('errorInfo'),
        totalUsage: ref('usage'),
        requestCount: { type: 'integer', minimum: 0 },
        toolCallCount: { type: 'integer', minimum: 0 },
        turns: { type: 'integer', minimum: 0 },
        checks: { type: 'array', items: ref('taskCheck') },
        toolsUsed: { type: 'array', items: { type: 'string' } },
        formsUsed: { type: 'array', items: { enum: ['direct', 'delegated', 'team', 'workflow'] } },
        componentsUsed: { type: 'array', items: ref('componentUsage') },
        memberCosts: { type: 'array', items: ref('memberCost') },
      },
      ['sessionId', 'status', 'totalUsage', 'requestCount', 'toolCallCount', 'turns', 'toolsUsed'],
    ),
    capabilityDecisionRecord: record(
      'capability.decision',
      {
        decisionId: ref('nonEmptyString'),
        outcome: { enum: [...DECISION_OUTCOMES] },
        reason: { enum: [...DECISION_REASONS] },
        trigger: { enum: [...ACTIVATION_TRIGGERS] },
        fromVersion: ref('capabilityVersion'),
        toVersion: ref('capabilityVersion'),
        candidateId: ref('nonEmptyString'),
        revision: ref('positiveInteger'),
      },
      ['decisionId', 'outcome', 'reason', 'trigger', 'fromVersion', 'toVersion'],
    ),
    improvementEndRecord: record(
      'improvement.end',
      {
        jobId: ref('nonEmptyString'),
        kind: { enum: [...IMPROVEMENT_JOB_KINDS] },
        trigger: { enum: [...IMPROVEMENT_TRIGGERS] },
        status: { enum: [...IMPROVEMENT_STATUSES] },
        phases: {
          type: 'object',
          properties: Object.fromEntries(IMPROVEMENT_COST_PHASES.map(phase => [phase, ref('phaseCost')])),
        },
        candidateId: ref('nonEmptyString'),
        decisionId: ref('nonEmptyString'),
        childVersion: ref('improverVersion'),
      },
      ['jobId', 'trigger', 'status', 'phases'],
    ),
  },
}

const DEFS = ledgerRecordSchema.$defs as Record<string, JsonObject>
const KNOWN_TYPES = new Set<string>(LEDGER_RECORD_TYPES)

/** One validator per ledger record type. */
export const ledgerRecordValidators: Readonly<Record<LedgerRecordType, RecordValidator>> = Object.fromEntries(
  LEDGER_RECORD_TYPES.map(type => {
    const schema = DEFS[LEDGER_RECORD_DEFS[type]]
    if (schema === undefined) throw new Error(`missing ledger schema def for ${type}`)
    const validate: RecordValidator = (value, options) =>
      isJsonValue(value)
        ? evaluateSchema(ledgerRecordSchema, schema, value, options)
        : [{ path: '/', message: 'not a JSON-safe value' }]
    return [type, validate]
  }),
) as Record<LedgerRecordType, RecordValidator>

/** Whether `type` is a ledger record type this version knows. */
export function isLedgerRecordType(type: unknown): type is LedgerRecordType {
  return typeof type === 'string' && KNOWN_TYPES.has(type)
}

/**
 * Validate any ledger record: JSON-safe, a known `type`, and that type's schema.
 * @param options - `forbidAdditionalProperties` for writers.
 */
export function validateLedgerRecord(value: unknown, options?: EvaluateOptions): SchemaIssue[] {
  const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined
  if (!isLedgerRecordType(type)) return [{ path: '/type', message: `unknown record type ${JSON.stringify(type)}` }]
  return ledgerRecordValidators[type](value, options)
}
