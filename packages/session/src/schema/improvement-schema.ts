/**
 * JSON Schema of the step-5 improvement files under `.nexgent/improvements/`:
 * the trigger queue, job records and diagnoses, and the step-6 additions:
 * improver bundles and activation revisions (`.nexgent/improvers/`), meta
 * diagnoses, accepted improver changes and comparisons. Published as
 * `schema/improvement.v1.schema.json` (one document; validate a file against
 * `$defs/<name>`, see {@link IMPROVEMENT_FILE_DEFS}); a test keeps the file
 * identical to this object. The shared evaluator has no `maximum`,
 * `maxItems` or `maxLength`: count bounds (`IMPROVEMENT_LIMITS`) are
 * enforced by the writer (`@nexgent/evolve`), string bounds by patterns.
 *
 * Normative text: `docs/spec/data-formats.md` §改进作业, §改进器版本,
 * §元改进作业. Type mirrors: `packages/kernel/src/contracts/improvement.ts`,
 * `improver.ts`. The improver schema checks structure and patterns only;
 * the bounds and placeholder rules are `assertImproverBundle`'s.
 */
import {
  CAPABILITY_COMPONENT_KINDS,
  COMPARISON_ARMS,
  COMPARISON_ORIGIN_KINDS,
  COMPONENT_NAME_PATTERN,
  FAILURE_CATEGORIES,
  IMPROVEMENT_COST_PHASES,
  IMPROVEMENT_JOB_KINDS,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_PHASES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TRIGGERS,
  IMPROVER_ACTIVATION_TRIGGERS,
  IMPROVER_CHANGE_OPS,
  IMPROVER_DECISION_REASONS,
  IMPROVER_LIMITS,
  IMPROVER_PARAM_BOUNDS,
  IMPROVER_PARAMS,
  IMPROVER_VERSION_PATTERN,
  isJsonValue,
  META_FINDING_STAGES,
  PROPOSABLE_KINDS,
  REPLAY_SELECTIONS,
  type JsonObject,
} from '@nexgent/kernel'
import { CAPABILITY_VERSION_SCHEMA, capabilitiesSchema } from './capabilities-schema.js'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'

/** The file kinds this schema covers, and their `$defs` keys. */
export const IMPROVEMENT_FILE_DEFS = {
  queue: 'improvementQueue',
  job: 'improvementJob',
  diagnosis: 'diagnosis',
  /** Step 6: `.nexgent/improvers/bundles/<version>.json`. */
  improver: 'improverBundle',
  /** Step 6: `.nexgent/improvers/activation/<n>.json`. */
  improverRevision: 'improverRevision',
  /** Step 6: `<jobId>/meta-diagnosis.json`. */
  metaDiagnosis: 'metaDiagnosis',
  /** Step 6: `<jobId>/change.json`. */
  change: 'improverChangeRecord',
  /** Step 6: `<jobId>/comparison.json`. */
  comparison: 'improverComparison',
} as const

/** A file kind of {@link IMPROVEMENT_FILE_DEFS}. */
export type ImprovementFileKind = keyof typeof IMPROVEMENT_FILE_DEFS

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const bounded = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{0,${n}}$` })
const boundedNonEmpty = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{1,${n}}$` })
const nonNegativeInteger: JsonObject = { type: 'integer', minimum: 0 }
const names: JsonObject = { type: 'array', items: ref('nonEmptyString') }
const range = (bounds: { readonly min: number; readonly max: number }): JsonObject => ({ enum: Array.from({ length: bounds.max - bounds.min + 1 }, (_, index) => bounds.min + index) })
const CAPABILITY_DEFS = capabilitiesSchema.$defs as Record<string, JsonObject>

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
    improverVersion: { type: 'string', pattern: IMPROVER_VERSION_PATTERN.source },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    trialVerdict: CAPABILITY_DEFS.trialVerdict as JsonObject,
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
        metaCounted: { type: 'array', items: ref('uuid') },
        metaPending: { type: 'array', items: ref('uuid') },
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
        kind: { enum: [...IMPROVEMENT_JOB_KINDS] },
        improverVersion: ref('improverVersion'),
        arm: closedObject({ metaJobId: ref('uuid'), arm: { enum: [...COMPARISON_ARMS] } }, ['metaJobId', 'arm']),
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
        phases: closedObject(Object.fromEntries(IMPROVEMENT_COST_PHASES.map(phase => [phase, ref('phaseCost')])), []),
        baseVersion: ref('capabilityVersion'),
        sessions: closedObject(Object.fromEntries(IMPROVEMENT_PHASES.filter(phase => phase !== 'trial').map(phase => [phase, ref('nonEmptyString')])), []),
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
        meta: ref('metaJobState'),
      },
      ['formatVersion', 'id', 'createdAt', 'updatedAt', 'trigger', 'status', 'items', 'history', 'phases'],
    ),
    metaJobState: closedObject(
      {
        basis: { type: 'array', items: ref('uuid') },
        parentVersion: ref('improverVersion'),
        childVersion: ref('improverVersion'),
        keepCopies: { type: 'boolean' },
        diagnosed: closedObject(
          { at: ref('timestamp'), attempts: ref('positiveInteger'), proposal: { enum: ['change', 'none'] } },
          ['at', 'attempts', 'proposal'],
        ),
        compared: closedObject(
          { at: ref('timestamp'), outcome: { enum: ['adopt', 'reject'] }, reason: { enum: [...IMPROVER_DECISION_REASONS] } },
          ['at', 'outcome', 'reason'],
        ),
        revision: ref('positiveInteger'),
      },
      ['basis', 'parentVersion'],
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
        executionForm: { enum: ['direct', 'delegated', 'team', 'workflow'] },
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
    // Step 6 (ADR 0008).
    proposableKind: { enum: [...PROPOSABLE_KINDS] },
    improverBundle: closedObject(
      {
        formatVersion: { const: 1 },
        diagnosis: closedObject(
          { paragraphs: { type: 'array', minItems: 1, items: { type: 'string', pattern: `^[^\\n]{1,${IMPROVER_LIMITS.maxParagraphChars}}$` } } },
          ['paragraphs'],
        ),
        proposal: closedObject(
          {
            kinds: { type: 'array', minItems: 1, items: ref('proposableKind') },
            briefs: closedObject(Object.fromEntries(PROPOSABLE_KINDS.map(kind => [kind, boundedNonEmpty(IMPROVER_LIMITS.maxBriefChars)])), []),
          },
          ['kinds', 'briefs'],
        ),
        comparison: ref('improverComparisonParams'),
      },
      ['formatVersion', 'diagnosis', 'proposal', 'comparison'],
    ),
    improverComparisonParams: closedObject(
      {
        selectionCases: range(IMPROVER_PARAM_BOUNDS.selectionCases),
        repeats: range(IMPROVER_PARAM_BOUNDS.repeats),
        selection: { enum: [...REPLAY_SELECTIONS] },
      },
      ['selectionCases', 'repeats', 'selection'],
    ),
    improverRevision: closedObject(
      {
        format: { const: 1 },
        revision: ref('positiveInteger'),
        previous: { anyOf: [ref('sha256'), { type: 'null' }] },
        from: ref('improverVersion'),
        version: ref('improverVersion'),
        type: { enum: ['adopt', 'rollback'] },
        trigger: { enum: [...IMPROVER_ACTIVATION_TRIGGERS] },
        jobId: ref('uuid'),
        reason: bounded(IMPROVER_LIMITS.maxReasonChars),
        committedAt: ref('timestamp'),
      },
      ['format', 'revision', 'previous', 'from', 'version', 'type', 'trigger', 'committedAt'],
    ),
    metaFinding: closedObject(
      {
        stage: { enum: [...META_FINDING_STAGES] },
        label: boundedNonEmpty(IMPROVER_LIMITS.maxLabelChars),
        jobIds: { type: 'array', minItems: 1, items: ref('uuid') },
      },
      ['stage', 'label', 'jobIds'],
    ),
    metaDiagnosis: closedObject(
      {
        formatVersion: { const: 1 },
        jobId: ref('uuid'),
        createdAt: ref('timestamp'),
        sessionId: ref('nonEmptyString'),
        attempts: { enum: Array.from({ length: IMPROVER_LIMITS.maxMetaDiagnosisAttempts }, (_, index) => index + 1) },
        improverVersion: ref('improverVersion'),
        basis: { type: 'array', items: ref('uuid') },
        statusCounts: closedObject(Object.fromEntries(IMPROVEMENT_STATUSES.map(status => [status, nonNegativeInteger])), []),
        findings: { type: 'array', items: ref('metaFinding') },
        hypothesis: boundedNonEmpty(IMPROVER_LIMITS.maxHypothesisChars),
        proposal: { enum: ['change', 'none'] },
      },
      ['formatVersion', 'jobId', 'createdAt', 'sessionId', 'attempts', 'improverVersion', 'basis', 'statusCounts', 'findings', 'hypothesis', 'proposal'],
    ),
    improverChange: {
      oneOf: [
        closedObject(
          { op: { const: 'set-diagnosis-paragraph' }, index: nonNegativeInteger, text: { type: 'string', pattern: `^[^\\n]{1,${IMPROVER_LIMITS.maxParagraphChars}}$` } },
          ['op', 'index', 'text'],
        ),
        closedObject({ op: { const: 'set-proposal-kinds' }, kinds: { type: 'array', minItems: 1, items: ref('proposableKind') } }, ['op', 'kinds']),
        closedObject(
          { op: { const: 'set-proposal-brief' }, kind: ref('proposableKind'), template: boundedNonEmpty(IMPROVER_LIMITS.maxBriefChars) },
          ['op', 'kind', 'template'],
        ),
        closedObject(
          { op: { const: 'set-comparison-param' }, param: { enum: [...IMPROVER_PARAMS] }, value: { anyOf: [{ type: 'integer' }, { enum: [...REPLAY_SELECTIONS] }] } },
          ['op', 'param', 'value'],
        ),
      ],
    },
    improverChangeRecord: closedObject(
      {
        formatVersion: { const: 1 },
        jobId: ref('uuid'),
        createdAt: ref('timestamp'),
        sessionId: ref('nonEmptyString'),
        attempts: { enum: Array.from({ length: IMPROVER_LIMITS.maxChangeAttempts }, (_, index) => index + 1) },
        parentVersion: ref('improverVersion'),
        childVersion: ref('improverVersion'),
        change: ref('improverChange'),
        rationale: boundedNonEmpty(IMPROVER_LIMITS.maxRationaleChars),
      },
      ['formatVersion', 'jobId', 'createdAt', 'sessionId', 'attempts', 'parentVersion', 'childVersion', 'change', 'rationale'],
    ),
    comparisonOrigin: closedObject(
      {
        kind: { enum: [...COMPARISON_ORIGIN_KINDS] },
        sourceJobId: ref('uuid'),
        tree: ref('sha256'),
        feedbackIds: names,
        capabilityVersion: ref('capabilityVersion'),
        epoch: ref('sha256'),
      },
      ['kind', 'sourceJobId', 'tree', 'feedbackIds', 'capabilityVersion', 'epoch'],
    ),
    comparisonArmResult: closedObject(
      {
        arm: { enum: [...COMPARISON_ARMS] },
        improverVersion: ref('improverVersion'),
        origin: ref('comparisonOrigin'),
        jobId: ref('uuid'),
        status: ref('improvementStatus'),
        error: ref('errorInfo'),
        candidateId: ref('uuid'),
        verdict: ref('trialVerdict'),
        cost: closedObject(
          { usage: ref('usage'), requestCount: nonNegativeInteger, estimatedUsd: { anyOf: [{ type: 'number', minimum: 0 }, { const: 'unknown' }] } },
          ['usage', 'requestCount', 'estimatedUsd'],
        ),
      },
      ['arm', 'improverVersion', 'origin', 'jobId', 'status', 'cost'],
    ),
    keptCopy: closedObject({ root: ref('nonEmptyString'), bytes: nonNegativeInteger }, ['root', 'bytes']),
    improverComparison: closedObject(
      {
        formatVersion: { const: 1 },
        jobId: ref('uuid'),
        createdAt: ref('timestamp'),
        origin: ref('comparisonOrigin'),
        parent: ref('comparisonArmResult'),
        child: ref('comparisonArmResult'),
        verdict: closedObject(
          {
            outcome: { enum: ['adopt', 'reject'] },
            reason: { enum: [...IMPROVER_DECISION_REASONS] },
            quality: closedObject({ parent: { type: 'number', minimum: 0 }, child: { type: 'number', minimum: 0 } }, ['parent', 'child']),
            costRatio: { type: 'number', minimum: 0 },
          },
          ['outcome', 'reason'],
        ),
        kept: closedObject({ parent: ref('keptCopy'), child: ref('keptCopy') }, []),
      },
      ['formatVersion', 'jobId', 'createdAt', 'origin', 'parent', 'child', 'verdict'],
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
