/**
 * JSON Schema of the step-5 improvement files under `.nexgent/improvements/`:
 * the trigger queue, job records and diagnoses. Published as
 * `schema/improvement.v1.schema.json` (one document; validate a file against
 * `$defs/<name>`, see {@link IMPROVEMENT_FILE_DEFS}); a test keeps the file
 * identical to this object. The shared evaluator has no `maximum`,
 * `maxItems` or `maxLength`: count bounds (`IMPROVEMENT_LIMITS`) are
 * enforced by the writer (`@nexgent/evolve`), string bounds by patterns.
 *
 * Normative text: `docs/spec/data-formats.md` §改进作业. Type mirror:
 * `packages/kernel/src/contracts/improvement.ts`.
 */
import {
  CAPABILITY_COMPONENT_KINDS,
  COMPONENT_NAME_PATTERN,
  FAILURE_CATEGORIES,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_PHASES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TRIGGERS,
  isJsonValue,
  type JsonObject,
} from '@nexgent/kernel'
import { CAPABILITY_VERSION_SCHEMA } from './capabilities-schema.js'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'

/** The file kinds this schema covers, and their `$defs` keys. */
export const IMPROVEMENT_FILE_DEFS = {
  queue: 'improvementQueue',
  job: 'improvementJob',
  diagnosis: 'diagnosis',
} as const

/** A file kind of {@link IMPROVEMENT_FILE_DEFS}. */
export type ImprovementFileKind = keyof typeof IMPROVEMENT_FILE_DEFS

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const bounded = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{0,${n}}$` })
const boundedNonEmpty = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{1,${n}}$` })
const nonNegativeInteger: JsonObject = { type: 'integer', minimum: 0 }
const names: JsonObject = { type: 'array', items: ref('nonEmptyString') }

/** The improvement file schema (draft 2020-12). */
export const improvementSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/improvement.v1.schema.json',
  title: 'Nexgent improvement files v1',
  description: 'Files under .nexgent/improvements/; validate against $defs/<name>. See docs/spec/data-formats.md.',
  $defs: {
    timestamp: COMMON_DEFS.timestamp as JsonObject,
    nonEmptyString: COMMON_DEFS.nonEmptyString as JsonObject,
    positiveInteger: COMMON_DEFS.positiveInteger as JsonObject,
    usageCount: COMMON_DEFS.usageCount as JsonObject,
    usage: COMMON_DEFS.usage as JsonObject,
    errorInfo: COMMON_DEFS.errorInfo as JsonObject,
    uuid: { type: 'string', pattern: UUID },
    capabilityVersion: CAPABILITY_VERSION_SCHEMA,
    componentKind: { enum: [...CAPABILITY_COMPONENT_KINDS] },
    proposalKind: { enum: [...CAPABILITY_COMPONENT_KINDS, 'none'] },
    improvementStatus: { enum: [...IMPROVEMENT_STATUSES] },
    improvementSignal: {
      oneOf: [
        closedObject(
          {
            kind: { const: 'feedback' },
            feedbackId: ref('nonEmptyString'),
            sessionId: ref('nonEmptyString'),
            deliverableId: ref('nonEmptyString'),
            version: ref('positiveInteger'),
            rating: { enum: [1, 2, 3, 4, 5] },
            at: ref('timestamp'),
          },
          ['kind', 'feedbackId', 'sessionId', 'deliverableId', 'at'],
        ),
        closedObject(
          {
            kind: { const: 'check-failure' },
            taskId: ref('nonEmptyString'),
            sessionId: ref('nonEmptyString'),
            turn: ref('positiveInteger'),
            failedChecks: { type: 'array', items: { type: 'string' } },
            at: ref('timestamp'),
          },
          ['kind', 'taskId', 'sessionId', 'turn', 'at'],
        ),
      ],
    },
    improvementQueue: closedObject(
      {
        formatVersion: { const: 1 },
        since: ref('timestamp'),
        counted: { type: 'array', items: ref('nonEmptyString') },
        pending: { type: 'array', items: ref('improvementSignal') },
        activeJobId: ref('uuid'),
      },
      ['formatVersion', 'since', 'counted', 'pending'],
    ),
    phaseCost: closedObject({ usage: ref('usage'), requestCount: nonNegativeInteger }, ['usage', 'requestCount']),
    statusChange: closedObject(
      { status: ref('improvementStatus'), at: ref('timestamp'), detail: bounded(IMPROVEMENT_LIMITS.maxDetailChars) },
      ['status', 'at'],
    ),
    improvementJob: closedObject(
      {
        formatVersion: { const: 1 },
        id: ref('uuid'),
        createdAt: ref('timestamp'),
        updatedAt: ref('timestamp'),
        trigger: { enum: [...IMPROVEMENT_TRIGGERS] },
        status: ref('improvementStatus'),
        items: { type: 'array', items: ref('improvementSignal') },
        request: closedObject(
          {
            sessionId: ref('nonEmptyString'),
            deliverableId: ref('nonEmptyString'),
            version: ref('positiveInteger'),
            taskId: ref('nonEmptyString'),
            note: bounded(IMPROVEMENT_LIMITS.maxDetailChars),
          },
          [],
        ),
        history: { type: 'array', minItems: 1, items: ref('statusChange') },
        phases: closedObject(Object.fromEntries(IMPROVEMENT_PHASES.map(phase => [phase, ref('phaseCost')])), []),
        baseVersion: ref('capabilityVersion'),
        sessions: closedObject({ diagnose: ref('nonEmptyString'), propose: ref('nonEmptyString') }, []),
        diagnosed: closedObject(
          { at: ref('timestamp'), proposalKind: ref('proposalKind'), attempts: ref('positiveInteger') },
          ['at', 'proposalKind', 'attempts'],
        ),
        candidateId: ref('uuid'),
        trialId: ref('uuid'),
        decisionId: ref('uuid'),
        firstUse: closedObject(
          { taskId: ref('nonEmptyString'), sessionId: ref('nonEmptyString'), at: ref('timestamp'), version: ref('capabilityVersion') },
          ['taskId', 'sessionId', 'at', 'version'],
        ),
        rolledBack: closedObject({ decisionId: ref('uuid'), at: ref('timestamp') }, ['decisionId', 'at']),
        detail: bounded(IMPROVEMENT_LIMITS.maxDetailChars),
        error: ref('errorInfo'),
      },
      ['formatVersion', 'id', 'createdAt', 'updatedAt', 'trigger', 'status', 'items', 'history', 'phases'],
    ),
    evidenceRef: closedObject(
      { sessionId: ref('nonEmptyString'), seq: ref('positiveInteger'), turn: ref('positiveInteger') },
      ['sessionId', 'seq'],
    ),
    diagnosedFailure: closedObject(
      {
        category: { enum: [...FAILURE_CATEGORIES] },
        label: boundedNonEmpty(IMPROVEMENT_LIMITS.maxLabelChars),
        evidence: { type: 'array', minItems: 1, items: ref('evidenceRef') },
      },
      ['category', 'label', 'evidence'],
    ),
    componentRef: closedObject(
      { kind: ref('componentKind'), name: { type: 'string', pattern: COMPONENT_NAME_PATTERN.source } },
      ['kind', 'name'],
    ),
    diagnosisInvolved: closedObject(
      { members: names, tools: names, skills: names, components: { type: 'array', items: ref('componentRef') } },
      ['members', 'tools', 'skills', 'components'],
    ),
    memberCost: closedObject(
      {
        memberId: ref('nonEmptyString'),
        name: { type: 'string' },
        executionForm: { enum: ['delegated', 'team', 'workflow'] },
        usage: ref('usage'),
        requestCount: nonNegativeInteger,
        toolCallCount: nonNegativeInteger,
      },
      ['memberId', 'name', 'executionForm', 'usage', 'requestCount', 'toolCallCount'],
    ),
    diagnosis: closedObject(
      {
        formatVersion: { const: 1 },
        jobId: ref('uuid'),
        createdAt: ref('timestamp'),
        sessionId: ref('nonEmptyString'),
        attempts: { enum: Array.from({ length: IMPROVEMENT_LIMITS.maxDiagnosisAttempts }, (_, index) => index + 1) },
        failureTypes: { type: 'array', items: ref('diagnosedFailure') },
        involved: ref('diagnosisInvolved'),
        hypothesis: boundedNonEmpty(IMPROVEMENT_LIMITS.maxHypothesisChars),
        proposalKind: ref('proposalKind'),
        memberCosts: { type: 'array', items: ref('memberCost') },
      },
      ['formatVersion', 'jobId', 'createdAt', 'sessionId', 'attempts', 'failureTypes', 'involved', 'hypothesis', 'proposalKind', 'memberCosts'],
    ),
  },
}

const DEFS = improvementSchema.$defs as Record<string, JsonObject>

/** Validate one value against an improvement file kind; empty = valid. */
export function validateImprovementFile(kind: ImprovementFileKind, value: unknown, options?: EvaluateOptions): SchemaIssue[] {
  const schema = DEFS[IMPROVEMENT_FILE_DEFS[kind]]
  if (schema === undefined) throw new Error(`missing improvement schema def for ${kind}`)
  if (!isJsonValue(value)) return [{ path: '/', message: 'not a JSON-safe value' }]
  return evaluateSchema(improvementSchema, schema, value, options)
}
