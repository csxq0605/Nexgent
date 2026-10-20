/**
 * JSON Schema of the rework C1 files (ADR 0017–0019): the project identity
 * and the user data directory files (`project.json`, `grants.json`,
 * `migration.json`), self-evaluations and handbook
 * operations, and handbook usage lines (ADR 0023). Published as `schema/learning.v1.schema.json` (one document;
 * validate a file against `$defs/<name>`, see {@link LEARNING_FILE_DEFS}); a
 * test keeps the file identical to this object. The shared evaluator has no
 * `maximum`, `maxItems` or `maxLength`: count bounds (`HANDBOOK_LIMITS`,
 * `SELF_EVAL_LIMITS`) are enforced by the writers, string
 * bounds by patterns.
 *
 * Normative text: `docs/spec/data-formats.md` §用户数据目录, §迁移, §自评,
 * §练习题集, §经验手册. Type mirrors: `packages/kernel/src/contracts/
 * data-layout.ts`, `learning.ts`, `handbook.ts`.
 */
import {
  HANDBOOK_ACTORS,
  HANDBOOK_DRAWS,
  HANDBOOK_EVIDENCE,
  HANDBOOK_OUTCOME_EVIDENCE,
  HANDBOOK_ENTRY_STATUSES,
  HANDBOOK_LIMITS,
  HANDBOOK_SCOPES,
  isJsonValue,
  LEARNING_RULES,
  MIGRATION_STATUSES,
  PROJECT_DATA_SUBDIRS,
  SELF_EVAL_LIMITS,
  SELF_EVAL_OUTCOMES,
  SELF_EVAL_SAMPLES,
  USER_PROJECT_ID_PATTERN,
  type JsonObject,
} from '@nexgent/kernel'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'

/** The file kinds this schema covers, and their `$defs` keys. */
export const LEARNING_FILE_DEFS = {
  /** `.nexgent/project.json`. */
  projectIdentity: 'projectIdentity',
  /** `<home>/projects/<projectId>/project.json`. */
  projectDataIndex: 'projectDataIndex',
  /** `<home>/projects/<projectId>/grants.json`. */
  projectGrants: 'projectGrants',
  /** `<home>/projects/<projectId>/migration.json`. */
  migration: 'migrationRecord',
  /** `<projectdata>/evaluations/<taskId>.json`. */
  selfEvaluation: 'selfEvaluation',
  /** One line of `handbook/ops.jsonl`. */
  handbookOp: 'handbookOp',
  /** One line of `handbook/usage.jsonl` (ADR 0023 exposure and outcome). */
  handbookUsage: 'handbookUsage',
} as const

/** A file kind of {@link LEARNING_FILE_DEFS}. */
export type LearningFileKind = keyof typeof LEARNING_FILE_DEFS

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const boundedNonEmpty = (n: number): JsonObject => ({ type: 'string', pattern: `^[\\s\\S]{1,${n}}$` })
const nonNegativeInteger: JsonObject = { type: 'integer', minimum: 0 }
const unitScore: JsonObject = { type: 'number', minimum: 0 }
const projectId: JsonObject = { type: 'string', pattern: USER_PROJECT_ID_PATTERN.source }
const keyword = (n: number): JsonObject => ({ type: 'string', pattern: `^[^A-Z\\n]{1,${n}}$` })

/** The learning file schema (draft 2020-12). */
export const learningSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/learning.v1.schema.json',
  title: 'Nexgent learning and user-data files v1',
  description: 'Project identity, user data directory files, self-evaluations and handbook operations (ADR 0017-0019). Validate a file against $defs/<name>. See docs/spec/data-formats.md.',
  $defs: {
    ...COMMON_DEFS,
    projectId,
    uuid: { type: 'string', pattern: UUID },
    approvalGrant: closedObject({ tool: ref('nonEmptyString'), pattern: { type: 'string' }, grantedAt: ref('timestamp') }, ['tool', 'grantedAt']),
    taskCheck: closedObject({ name: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' }, target: { type: 'string' } }, ['name', 'passed']),
    learningCost: closedObject(
      { usage: ref('usage'), requestCount: nonNegativeInteger, estimatedUsd: { anyOf: [ref('nonNegativeNumber'), { const: 'unknown' }] } },
      ['usage', 'requestCount', 'estimatedUsd'],
    ),
    projectIdentity: closedObject(
      { formatVersion: { const: 1 }, projectId: ref('projectId'), createdAt: ref('timestamp'), name: boundedNonEmpty(200) },
      ['formatVersion', 'projectId', 'createdAt'],
    ),
    projectDataIndex: closedObject(
      { formatVersion: { const: 1 }, projectId: ref('projectId'), root: ref('nonEmptyString'), lastOpenedAt: ref('timestamp') },
      ['formatVersion', 'projectId', 'root', 'lastOpenedAt'],
    ),
    projectGrants: closedObject(
      { formatVersion: { const: 1 }, approvals: { type: 'array', items: ref('approvalGrant') } },
      ['formatVersion', 'approvals'],
    ),
    migrationEntry: closedObject({ name: { enum: [...PROJECT_DATA_SUBDIRS] }, files: nonNegativeInteger, bytes: nonNegativeInteger }, ['name', 'files', 'bytes']),
    migrationRecord: closedObject(
      {
        formatVersion: { const: 1 },
        projectId: ref('projectId'),
        from: ref('nonEmptyString'),
        status: { enum: [...MIGRATION_STATUSES] },
        startedAt: ref('timestamp'),
        finishedAt: ref('timestamp'),
        entries: { type: 'array', items: ref('migrationEntry') },
        grantsMoved: nonNegativeInteger,
        oldDataKept: { const: true },
        oldDataRemovedAt: ref('timestamp'),
        error: ref('errorInfo'),
      },
      ['formatVersion', 'projectId', 'from', 'status', 'startedAt', 'entries', 'grantsMoved', 'oldDataKept'],
    ),
    rubricItem: closedObject(
      { id: { type: 'string', pattern: '^r[1-9][0-9]*$' }, text: boundedNonEmpty(SELF_EVAL_LIMITS.maxRubricItemChars), weight: { enum: [1, 2, 3] } },
      ['id', 'text'],
    ),
    rubric: closedObject(
      { items: { type: 'array', minItems: 1, items: ref('rubricItem') }, model: ref('nonEmptyString'), createdAt: ref('timestamp'), generator: ref('nonEmptyString') },
      ['items', 'model', 'createdAt', 'generator'],
    ),
    rubricScore: closedObject(
      { itemId: ref('nonEmptyString'), score: { enum: [0, 0.5, 1] }, note: boundedNonEmpty(SELF_EVAL_LIMITS.maxNoteChars) },
      ['itemId', 'score'],
    ),
    selfEvalCalibration: closedObject(
      { model: ref('nonEmptyString'), score: unitScore, agree: { type: 'boolean' }, at: ref('timestamp'), cost: ref('learningCost') },
      ['model', 'score', 'agree', 'at', 'cost'],
    ),
    selfEvaluation: closedObject(
      {
        formatVersion: { const: 1 },
        rules: { const: LEARNING_RULES },
        projectId: ref('projectId'),
        taskId: ref('nonEmptyString'),
        sessionId: ref('nonEmptyString'),
        turn: ref('positiveInteger'),
        createdAt: ref('timestamp'),
        checks: { type: 'array', items: ref('taskCheck') },
        sample: { enum: [...SELF_EVAL_SAMPLES] },
        rubric: ref('rubric'),
        scores: { type: 'array', items: ref('rubricScore') },
        scorer: ref('nonEmptyString'),
        feedback: closedObject(
          { feedbackIds: { type: 'array', items: ref('nonEmptyString') }, rating: { enum: [1, 2, 3, 4, 5] } },
          ['feedbackIds'],
        ),
        score: unitScore,
        outcome: { enum: [...SELF_EVAL_OUTCOMES] },
        cost: ref('learningCost'),
        calibration: ref('selfEvalCalibration'),
      },
      ['formatVersion', 'rules', 'projectId', 'taskId', 'sessionId', 'turn', 'createdAt', 'checks', 'sample', 'outcome', 'cost'],
    ),
    handbookSource: closedObject({ projectId: ref('projectId'), taskId: ref('nonEmptyString'), sessionId: ref('nonEmptyString') }, ['taskId']),
    handbookKeywords: { type: 'array', items: keyword(HANDBOOK_LIMITS.maxKeywordChars) },
    handbookOp: {
      oneOf: [
        handbookOp('add', {
          text: boundedNonEmpty(HANDBOOK_LIMITS.maxTextChars),
          keywords: ref('handbookKeywords'),
          scope: { enum: [...HANDBOOK_SCOPES] },
          projectId: ref('projectId'),
          status: { enum: ['trial', 'active'] },
          supersedes: { type: 'array', items: ref('uuid') },
        }, ['text', 'keywords', 'scope']),
        handbookOp('edit', { text: boundedNonEmpty(HANDBOOK_LIMITS.maxTextChars), keywords: ref('handbookKeywords') }, []),
        handbookOp('upvote', {}, []),
        handbookOp('downvote', {}, []),
        handbookOp('status', { status: { enum: [...HANDBOOK_ENTRY_STATUSES] } }, ['status']),
      ],
    },
    handbookUsage: {
      oneOf: [
        usageLine('turn', {}, []),
        usageLine('hit', {
          entryId: ref('uuid'),
          given: { type: 'boolean' },
          taskId: ref('nonEmptyString'),
          status: { enum: HANDBOOK_ENTRY_STATUSES.filter(status => status !== 'retired') },
          draw: { enum: [...HANDBOOK_DRAWS] },
          showProbability: { enum: [HANDBOOK_EVIDENCE.trialShowProbability, HANDBOOK_EVIDENCE.activeShowProbability] },
        }, ['entryId', 'given']),
        usageLine('outcome', {
          taskId: ref('nonEmptyString'),
          score: unitScore,
          evidence: { type: 'array', minItems: 1, items: { enum: [...HANDBOOK_OUTCOME_EVIDENCE] } },
          userNegative: { type: 'boolean' },
        }, ['taskId', 'score', 'evidence']),
      ],
    },
  },
}

function handbookOp(op: string, properties: Record<string, JsonObject>, required: readonly string[]): JsonObject {
  return closedObject(
    {
      formatVersion: { const: 1 },
      op: { const: op },
      seq: ref('positiveInteger'),
      at: ref('timestamp'),
      entryId: ref('uuid'),
      actor: { enum: [...HANDBOOK_ACTORS] },
      source: ref('handbookSource'),
      reason: boundedNonEmpty(HANDBOOK_LIMITS.maxReasonChars),
      ...properties,
    },
    ['formatVersion', 'op', 'seq', 'at', 'entryId', 'actor', ...required],
  )
}

function usageLine(kind: string, properties: Record<string, JsonObject>, required: readonly string[]): JsonObject {
  return closedObject(
    { formatVersion: { const: 1 }, kind: { const: kind }, at: ref('timestamp'), projectId: ref('projectId'), sessionId: ref('nonEmptyString'), ...properties },
    ['formatVersion', 'kind', 'at', 'projectId', 'sessionId', ...required],
  )
}

const DEFS = learningSchema.$defs as Record<string, JsonObject>

/** Validate one value against a learning file kind; empty = valid. */
export function validateLearningFile(kind: LearningFileKind, value: unknown, options?: EvaluateOptions): SchemaIssue[] {
  const schema = DEFS[LEARNING_FILE_DEFS[kind]]
  if (schema === undefined) throw new Error(`missing learning schema def for ${kind}`)
  if (!isJsonValue(value)) return [{ path: '/', message: 'not a JSON-safe value' }]
  return evaluateSchema(learningSchema, schema, value, options)
}
