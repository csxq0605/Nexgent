/**
 * The step-6 improver contract: the improver as versioned data (diagnosis
 * policy paragraphs, proposal operators, bounded comparison parameters), its
 * built-in default `v0` (step 5's text and parameters, verbatim), the one
 * typed change a meta job may propose, the project's improver activation
 * chain, the meta diagnosis, the parent / child comparison and its pure
 * rule `decideImprover`, the evaluator settings an epoch id is computed
 * from, and the tools of the meta-job sessions.
 *
 * Legacy, kept only so old projects' data can be read: the feature is
 * deleted (`docs/spec/data-formats.md` §旧格式（只为读旧项目）; the original
 * ADR text is in the archive repository). JSON Schemas of the
 * files live in `@nexgent/session` (`improvement.v1.schema.json`). Types
 * and pure helpers only: hashing, storage and the meta job itself belong to
 * `@nexgent/capabilities` and `@nexgent/evolve`.
 */
import {
  canonicalJson,
  CAPABILITY_COMPONENT_KINDS,
  SHA256_PATTERN,
  type CapabilitiesConfig,
  type CapabilityComponentKind,
  type CapabilityVersion,
  type ReviewerSettings,
  type TrialVerdict,
} from './capabilities.js'
import { NexgentError } from './errors.js'
import {
  IMPROVE_READ_LEDGER_TOOL,
  IMPROVE_READ_SESSION_TOOL,
  isFinalImprovementStatus,
  type ComparisonArm,
  type ImprovementStatus,
  type ImprovementToolSpec,
  type PhaseCost,
} from './improvement.js'
import type { ErrorInfo } from './errors.js'
import type { InstanceLiteralText } from './instance-literals.js'
import type { JsonSchema, JsonValue } from './json.js'

// ---------------------------------------------------------------------------
// Versions and layout
// ---------------------------------------------------------------------------

/**
 * Identity of an improver: {@link IMPROVER_V0_VERSION} (the built-in
 * default, never stored) or the lowercase hex SHA-256 of
 * {@link canonicalImproverText}. A bundle whose canonical text equals
 * `v0`'s is `v0`.
 */
export type ImproverVersion = string

/** The built-in improver (step 5's behavior). */
export const IMPROVER_V0_VERSION = 'v0'

/** Pattern of an {@link ImproverVersion}. */
export const IMPROVER_VERSION_PATTERN = /^(?:v0|[a-f0-9]{64})$/

/**
 * `improvers/`, below the Nexgent home (`<NEXGENT_HOME>/improvers/`, ADR
 * 0012 decision 1: one version line shared by every project of the user)
 * and, read-only for history, below a project's `.nexgent/` (ADR 0008).
 * Host-written; the model's file tools can read and write none of it.
 */
export const IMPROVERS_DIR = 'improvers'

/**
 * Where the improver a job ran on lives (ADR 0012): `user` (the shared line
 * below the Nexgent home, every job from the rework on) or `project` (a
 * project's own `.nexgent/improvers/`, ADR 0008; read-only history). A job,
 * ledger record or session without the field is `project` data.
 */
export type ImproverScope = 'user' | 'project'

/** Every scope. */
export const IMPROVER_SCOPES: readonly ImproverScope[] = ['user', 'project']

/** Layout below an `improvers/` directory (user-level since ADR 0012; project-level before). */
export const IMPROVER_DIRS = {
  /** `bundles/<version>.json`: every improver ever proposed (written `wx` once, never changed). */
  bundles: 'bundles',
  /** `activation/<n>.json`: the revision chain; its tail is the improver in force (`v0` at revision 0). */
  activation: 'activation',
} as const

/** Bounds every writer and reader enforces. */
export const IMPROVER_LIMITS = {
  /** Paragraphs of the diagnosis policy, characters of one. */
  maxParagraphs: 16,
  maxParagraphChars: 2_000,
  /** Characters of one proposal brief template. */
  maxBriefChars: 4_000,
  /** Characters of a change's rationale, a finding's label, the meta hypothesis, a revision's reason. */
  maxRationaleChars: 1_000,
  maxLabelChars: 200,
  maxHypothesisChars: 500,
  maxReasonChars: 2_000,
  /** Findings in one meta diagnosis, job ids cited per finding. */
  maxFindings: 8,
  maxFindingJobs: 16,
  /** Meta-diagnosis reports and change proposals a meta job asks for before it fails. */
  maxMetaDiagnosisAttempts: 3,
  maxChangeAttempts: 3,
} as const

// ---------------------------------------------------------------------------
// The improver bundle
// ---------------------------------------------------------------------------

/** Component kinds an improvement job may propose: every kind but `plugin` (ADR 0006 decision 5). */
export type ProposableKind = Exclude<CapabilityComponentKind, 'plugin'>

/** Every proposable kind, in manifest order. */
export const PROPOSABLE_KINDS: readonly ProposableKind[] = CAPABILITY_COMPONENT_KINDS.filter((kind): kind is ProposableKind => kind !== 'plugin')

/**
 * How the gate of an improvement job picks its selection cases besides the
 * feedback task: `similarity` (word overlap with the anchor task, step 4–5)
 * or `recency` (the newest past tasks). The guard set is always the least
 * similar tasks (evaluator, not improver).
 */
export type ReplaySelection = 'similarity' | 'recency'

/** Every selection method. */
export const REPLAY_SELECTIONS: readonly ReplaySelection[] = ['similarity', 'recency']

/**
 * The comparison parameters an improver sets for the gate trials of its
 * jobs (ADR 0008 decision 2). The project's `capabilities.selectionCases` /
 * `repeats` stay floors: the effective value is the larger of the two
 * ({@link effectiveTrialCounts}), so an improver can ask for more evidence,
 * never less.
 */
export interface ImproverComparisonParams {
  /** Selection cases, {@link IMPROVER_PARAM_BOUNDS}. */
  readonly selectionCases: number
  /** Runs per arm per case, {@link IMPROVER_PARAM_BOUNDS}. */
  readonly repeats: number
  readonly selection: ReplaySelection
}

/** Bounds of the numeric comparison parameters (ADR 0008 decision 2). */
export const IMPROVER_PARAM_BOUNDS = {
  selectionCases: { min: 2, max: 4 },
  repeats: { min: 2, max: 3 },
} as const

/**
 * An improver (ADR 0008 decision 1): three parts, all data. Placeholders
 * are `{{name}}` ({@link renderImproverText}); diagnosis paragraphs may use
 * {@link DIAGNOSIS_PLACEHOLDERS}, brief templates {@link BRIEF_PLACEHOLDERS}.
 */
export interface ImproverBundle {
  readonly formatVersion: 1
  /** The diagnosis policy: the paragraphs that open the diagnose session's first message, in order (joined by newlines). */
  readonly diagnosis: { readonly paragraphs: readonly string[] }
  /**
   * The proposal operators. `kinds`: the component kinds a diagnosis may
   * suggest, in order of preference (rendered by `{{allowedKinds}}`); a
   * diagnosis naming another kind does not reach the propose phase (the job
   * fails, as a `plugin` diagnosis did in step 5). `briefs`: the propose
   * session's brief per kind; every kind in `kinds` has one.
   */
  readonly proposal: {
    readonly kinds: readonly ProposableKind[]
    readonly briefs: Readonly<Partial<Record<ProposableKind, string>>>
  }
  /** The gate trial parameters of its jobs. */
  readonly comparison: ImproverComparisonParams
}

/** Placeholders a diagnosis paragraph may use: the allowed kinds in order, comma-separated. */
export const DIAGNOSIS_PLACEHOLDERS = ['allowedKinds'] as const

/**
 * Placeholders a brief template may use: the job id, the diagnosis
 * hypothesis, its first four failure types as `- <category>: <label>`
 * lines, the component kind to build.
 */
export const BRIEF_PLACEHOLDERS = ['jobId', 'hypothesis', 'failures', 'kind'] as const

const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g

/**
 * Fill `{{name}}` placeholders in one pass (pure): substituted text is never
 * scanned again. A line that is exactly one placeholder whose value is empty
 * is dropped (so `{{failures}}` without failures leaves no blank line).
 * @throws `internal` for a placeholder without a value.
 */
export function renderImproverText(template: string, values: Readonly<Record<string, string>>): string {
  const lines: string[] = []
  for (const line of template.split('\n')) {
    const only = /^\{\{([A-Za-z]+)\}\}$/.exec(line)
    if (only !== null && values[only[1]!] === '') continue
    lines.push(line.replace(PLACEHOLDER, (_match, name: string) => {
      const value = values[name]
      if (value === undefined) throw new NexgentError('internal', `no value for improver placeholder {{${name}}}`)
      return value
    }))
  }
  return lines.join('\n')
}

/** The placeholder names a text uses. */
export function improverPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map(match => match[1]!)
}

/** The diagnosis policy text of an improver (pure): its paragraphs, placeholders filled, joined by newlines. */
export function renderDiagnosisPolicy(bundle: ImproverBundle): string {
  return renderImproverText(bundle.diagnosis.paragraphs.join('\n'), { allowedKinds: bundle.proposal.kinds.join(', ') })
}

// The step-5 text, verbatim (`@nexgent/evolve` diagnosis.ts `POLICY`, propose.ts `proposalBrief`); a test keeps them equal.
const V0_PARAGRAPHS: readonly string[] = [
  'You are the diagnosis step of Nexgent\'s improvement job. A user worked on tasks in this project and was not satisfied (feedback, failed checks, or an explicit request to improve).',
  'Find out why, using only the read-only tools: read the sessions, the ledger and the feedback. You cannot change files or run anything.',
  'Classify each failure with one category: system-design (the specification or the way the work was set up was wrong or incomplete), inter-agent-misalignment (members of the task worked against or past each other), task-verification (the work was not checked, or ended before it was right).',
  'Cite evidence as {sessionId, seq} of real records (seq is the record\'s position in its session; add turn when you know it).',
  'Then decide whether a reusable capability component would have prevented the problem in future tasks of this kind: a skill (written practice the model loads), a function-module (tools as code), a context-policy (standing instructions), a preset, a team-template or an architecture. A plugin cannot be proposed by an improvement job.',
  'Answer proposalKind "none" when it is not a capability problem: the user changed or added a requirement only for this one deliverable, or the feedback is about taste, not about something future tasks should do.',
  'Report once with improve_report_diagnosis; if the host refuses it, fix exactly what it names and report again.',
]

const V0_BRIEF = [
  '# Improvement job',
  'You are redoing a past task in a copy of the project, for improvement job {{jobId}}. The user was not satisfied with how it was done before.',
  'Diagnosis: {{hypothesis}}',
  '{{failures}}',
  '',
  'While you do the task, build one reusable {{kind}} component that makes tasks like this come out right without the user having to ask again:',
  '1. capability_draft it, 2. capability_try it, 3. actually use it in this task (call its tool, load the skill, …) and finish the task with it,',
  '4. then capability_propose exactly that one component. Propose nothing else and nothing more than one component.',
  'A context-policy takes effect from the turn after you try it, and counts as used only once such a turn has completed: try it, finish the task, and do not propose it in the same turn; the host then gives you one turn to check the result under the policy and one more to propose it.',
  'Do not mention the improvement job in the deliverable itself.',
  '',
  '# The task',
].join('\n')

const V0_KINDS: readonly ProposableKind[] = ['skill', 'function-module', 'context-policy', 'preset', 'team-template', 'architecture']

/**
 * The built-in improver `v0` (ADR 0008 decision 1): step 5's diagnosis
 * policy and proposal brief verbatim, every proposable kind, and the gate
 * parameters of `DEFAULT_CAPABILITIES_CONFIG` (2 selection cases, 2 runs,
 * word-overlap selection). A project without improver revisions runs it.
 */
export const IMPROVER_V0: ImproverBundle = Object.freeze({
  formatVersion: 1,
  diagnosis: Object.freeze({ paragraphs: Object.freeze([...V0_PARAGRAPHS]) }),
  proposal: Object.freeze({
    kinds: Object.freeze([...V0_KINDS]),
    briefs: Object.freeze(Object.fromEntries(V0_KINDS.map(kind => [kind, V0_BRIEF]))),
  }),
  comparison: Object.freeze({ selectionCases: 2, repeats: 2, selection: 'similarity' as ReplaySelection }),
}) as ImproverBundle

/** Fields of a normalized bundle in a fixed shape (pure; returns a new bundle). Order of paragraphs and kinds is meaningful and kept. */
export function normalizeImprover(bundle: ImproverBundle): ImproverBundle {
  const briefs: Partial<Record<ProposableKind, string>> = {}
  for (const kind of PROPOSABLE_KINDS) {
    const brief = bundle.proposal.briefs[kind]
    if (brief !== undefined) briefs[kind] = brief
  }
  return {
    formatVersion: 1,
    diagnosis: { paragraphs: [...bundle.diagnosis.paragraphs] },
    proposal: { kinds: [...bundle.proposal.kinds], briefs },
    comparison: { selectionCases: bundle.comparison.selectionCases, repeats: bundle.comparison.repeats, selection: bundle.comparison.selection },
  }
}

/** The text whose SHA-256 (UTF-8, lowercase hex) is the improver's version: canonical JSON of the normalized bundle. */
export function canonicalImproverText(bundle: ImproverBundle): string {
  return canonicalJson(normalizeImprover(bundle) as unknown as JsonValue)
}

/** Whether a bundle is `v0` by content (then its version is {@link IMPROVER_V0_VERSION}, not a hash). */
export function isImproverV0(bundle: ImproverBundle): boolean {
  return canonicalImproverText(bundle) === canonicalImproverText(IMPROVER_V0)
}

/** The effective gate counts of an improvement job's trial: the larger of the project floor and the improver's value. */
export function effectiveTrialCounts(capabilities: Pick<CapabilitiesConfig, 'selectionCases' | 'repeats'>, improver: ImproverBundle): { readonly selectionCases: number; readonly repeats: number } {
  return {
    selectionCases: Math.max(capabilities.selectionCases, improver.comparison.selectionCases),
    repeats: Math.max(capabilities.repeats, improver.comparison.repeats),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Problems of a would-be bundle (structure, bounds, placeholders); empty = valid. Pure. */
export function improverProblems(value: unknown): string[] {
  const problems: string[] = []
  const known = (record: Record<string, unknown>, keys: readonly string[], at: string) => {
    for (const key of Object.keys(record)) if (!keys.includes(key)) problems.push(`${at}${key} is not a known field`)
  }
  if (!isRecord(value)) return ['the improver must be an object']
  known(value, ['formatVersion', 'diagnosis', 'proposal', 'comparison'], '')
  if (value.formatVersion !== 1) problems.push('formatVersion must be 1')
  const diagnosis = value.diagnosis
  if (!isRecord(diagnosis) || !Array.isArray(diagnosis.paragraphs)) {
    problems.push('diagnosis.paragraphs must be an array')
  } else {
    known(diagnosis, ['paragraphs'], 'diagnosis.')
    const paragraphs = diagnosis.paragraphs as unknown[]
    if (paragraphs.length < 1 || paragraphs.length > IMPROVER_LIMITS.maxParagraphs) problems.push(`diagnosis.paragraphs must have 1..${IMPROVER_LIMITS.maxParagraphs} items`)
    paragraphs.forEach((paragraph, index) => {
      if (typeof paragraph !== 'string' || paragraph.trim() === '' || paragraph.length > IMPROVER_LIMITS.maxParagraphChars) {
        problems.push(`diagnosis.paragraphs[${index}] must be non-empty text of at most ${IMPROVER_LIMITS.maxParagraphChars} characters`)
      } else if (paragraph.includes('\n')) {
        problems.push(`diagnosis.paragraphs[${index}] must be one line`)
      } else {
        for (const name of improverPlaceholders(paragraph)) if (!(DIAGNOSIS_PLACEHOLDERS as readonly string[]).includes(name)) problems.push(`diagnosis.paragraphs[${index}] uses unknown placeholder {{${name}}}`)
      }
    })
  }
  const proposal = value.proposal
  if (!isRecord(proposal) || !Array.isArray(proposal.kinds) || !isRecord(proposal.briefs)) {
    problems.push('proposal must have kinds (array) and briefs (object)')
  } else {
    known(proposal, ['kinds', 'briefs'], 'proposal.')
    const kinds = proposal.kinds as unknown[]
    if (kinds.length < 1) problems.push('proposal.kinds must name at least one kind')
    if (new Set(kinds).size !== kinds.length) problems.push('proposal.kinds must not repeat a kind')
    for (const kind of kinds) {
      if (!(PROPOSABLE_KINDS as readonly unknown[]).includes(kind)) problems.push(`proposal.kinds: ${JSON.stringify(kind)} is not a proposable kind (plugins never are)`)
      else if (typeof proposal.briefs[kind as string] !== 'string') problems.push(`proposal.briefs.${kind as string} is missing`)
    }
    for (const [kind, brief] of Object.entries(proposal.briefs)) {
      if (!(PROPOSABLE_KINDS as readonly string[]).includes(kind)) problems.push(`proposal.briefs.${kind} is not a proposable kind`)
      else if (typeof brief !== 'string' || brief.trim() === '' || brief.length > IMPROVER_LIMITS.maxBriefChars) problems.push(`proposal.briefs.${kind} must be non-empty text of at most ${IMPROVER_LIMITS.maxBriefChars} characters`)
      else for (const name of improverPlaceholders(brief)) if (!(BRIEF_PLACEHOLDERS as readonly string[]).includes(name)) problems.push(`proposal.briefs.${kind} uses unknown placeholder {{${name}}}`)
    }
  }
  const comparison = value.comparison
  if (!isRecord(comparison)) {
    problems.push('comparison must be an object')
  } else {
    known(comparison, ['selectionCases', 'repeats', 'selection'], 'comparison.')
    for (const param of ['selectionCases', 'repeats'] as const) {
      const entry = comparison[param]
      const { min, max } = IMPROVER_PARAM_BOUNDS[param]
      if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < min || entry > max) problems.push(`comparison.${param} must be an integer in ${min}..${max}`)
    }
    if (!(REPLAY_SELECTIONS as readonly unknown[]).includes(comparison.selection)) problems.push(`comparison.selection must be one of ${REPLAY_SELECTIONS.join(', ')}`)
  }
  return problems
}

/**
 * Check a bundle (W1's loader runs it on every read; a failing file is not
 * loaded and the chain falls back like a capability bundle).
 * @throws `improver/invalid` naming the problems.
 */
export function assertImproverBundle(value: unknown): asserts value is ImproverBundle {
  const problems = improverProblems(value)
  if (problems.length > 0) throw new NexgentError('improver/invalid', `improver: ${problems.join('; ')}`, { details: { problems } })
}

// ---------------------------------------------------------------------------
// Typed changes (the meta proposal)
// ---------------------------------------------------------------------------

/** A numeric or enumerated comparison parameter an improver may change. */
export type ImproverParam = keyof ImproverComparisonParams

/** Every changeable parameter. */
export const IMPROVER_PARAMS: readonly ImproverParam[] = ['selectionCases', 'repeats', 'selection']

/**
 * One typed change to an improver (ADR 0008 decision 2): rewrite or append
 * one diagnosis paragraph (`index` equal to the current count appends), set
 * the allowed kinds and their order, set one kind's brief template, or set
 * one comparison parameter within its bounds. Nothing else can be changed;
 * there is no free-form code.
 */
export type ImproverChange =
  | { readonly op: 'set-diagnosis-paragraph'; readonly index: number; readonly text: string }
  | { readonly op: 'set-proposal-kinds'; readonly kinds: readonly ProposableKind[] }
  | { readonly op: 'set-proposal-brief'; readonly kind: ProposableKind; readonly template: string }
  | { readonly op: 'set-comparison-param'; readonly param: ImproverParam; readonly value: number | ReplaySelection }

/** Every change operator. */
export const IMPROVER_CHANGE_OPS = ['set-diagnosis-paragraph', 'set-proposal-kinds', 'set-proposal-brief', 'set-comparison-param'] as const

/** The fields each operator takes (besides `op`). */
const OP_FIELDS: Readonly<Record<ImproverChange['op'], readonly string[]>> = {
  'set-diagnosis-paragraph': ['index', 'text'],
  'set-proposal-kinds': ['kinds'],
  'set-proposal-brief': ['kind', 'template'],
  'set-comparison-param': ['param', 'value'],
}

/**
 * Settings that belong to the evaluator (ADR 0008 decision 5) and that no
 * improver change can name: the adoption rule's cost ratios, the guard set,
 * the reviewer and feedback check, the budgets and the switches.
 */
export const EVALUATOR_FIELDS = [
  'costRatioCap', 'costApprovalRatio', 'guardCases', 'reviewer', 'feedbackCheck', 'trialBudget', 'rollback',
  'autoTrial', 'autoImprove', 'improvement', 'budget', 'feedbackThreshold', 'meta',
] as const

/** Why a proposed change was refused. */
export type ImproverChangeRefusal = 'not-one-change' | 'evaluator-field' | 'out-of-bounds' | 'invalid' | 'no-op' | 'instance-literal'

/** The outcome of {@link checkImproverChange}. */
export type ImproverChangeCheck =
  | { readonly ok: true; readonly change: ImproverChange; readonly child: ImproverBundle }
  | { readonly ok: false; readonly refusal: ImproverChangeRefusal; readonly problems: readonly string[] }

/** Apply a well-formed change (pure; no validation of the result, see {@link checkImproverChange}). */
export function applyImproverChange(bundle: ImproverBundle, change: ImproverChange): ImproverBundle {
  const base = normalizeImprover(bundle)
  switch (change.op) {
    case 'set-diagnosis-paragraph': {
      const paragraphs = [...base.diagnosis.paragraphs]
      paragraphs[change.index] = change.text
      return { ...base, diagnosis: { paragraphs } }
    }
    case 'set-proposal-kinds':
      return { ...base, proposal: { ...base.proposal, kinds: [...change.kinds] } }
    case 'set-proposal-brief':
      return { ...base, proposal: { ...base.proposal, briefs: { ...base.proposal.briefs, [change.kind]: change.template } } }
    case 'set-comparison-param':
      return { ...base, comparison: { ...base.comparison, [change.param]: change.value } }
  }
}

/**
 * Check one proposed change against the parent (pure): the input (the
 * `improve_propose_change` tool's `change` object) must be exactly one
 * operator with exactly its fields, name no evaluator field, stay within
 * bounds, give a valid child that differs from the parent.
 */
export function checkImproverChange(parent: ImproverBundle, input: unknown): ImproverChangeCheck {
  const refuse = (refusal: ImproverChangeRefusal, ...problems: string[]): ImproverChangeCheck => ({ ok: false, refusal, problems })
  if (Array.isArray(input)) return refuse('not-one-change', 'propose exactly one change, not a list')
  if (!isRecord(input)) return refuse('invalid', 'the change must be an object')
  const named = [...Object.keys(input), ...(typeof input.param === 'string' ? [input.param] : [])]
  const evaluator = named.filter(name => (EVALUATOR_FIELDS as readonly string[]).includes(name))
  if (evaluator.length > 0) return refuse('evaluator-field', `${evaluator.join(', ')} belongs to the evaluator; an improver cannot change it`)
  const op = input.op
  if (typeof op !== 'string' || !(IMPROVER_CHANGE_OPS as readonly string[]).includes(op)) return refuse('invalid', `op must be one of ${IMPROVER_CHANGE_OPS.join(', ')}`)
  const fields = OP_FIELDS[op as ImproverChange['op']]
  const extra = Object.keys(input).filter(key => key !== 'op' && !fields.includes(key))
  if (extra.length > 0) return refuse('not-one-change', `${op} takes only ${fields.join(', ')}; ${extra.join(', ')} would be another change`)
  const missing = fields.filter(key => input[key] === undefined)
  if (missing.length > 0) return refuse('invalid', `${op} needs ${missing.join(', ')}`)
  const base = normalizeImprover(parent)
  let change: ImproverChange
  switch (op as ImproverChange['op']) {
    case 'set-diagnosis-paragraph': {
      const { index, text } = input as { index: unknown; text: unknown }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > base.diagnosis.paragraphs.length) {
        return refuse('out-of-bounds', `index must be an integer in 0..${base.diagnosis.paragraphs.length} (equal to the count appends)`)
      }
      if (typeof text !== 'string') return refuse('invalid', 'text must be a string')
      change = { op: 'set-diagnosis-paragraph', index, text }
      break
    }
    case 'set-proposal-kinds': {
      const { kinds } = input as { kinds: unknown }
      if (!Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string')) return refuse('invalid', 'kinds must be an array of kinds')
      change = { op: 'set-proposal-kinds', kinds: kinds as ProposableKind[] }
      break
    }
    case 'set-proposal-brief': {
      const { kind, template } = input as { kind: unknown; template: unknown }
      if (typeof kind !== 'string' || !(PROPOSABLE_KINDS as readonly string[]).includes(kind)) return refuse('invalid', 'kind must be a proposable kind (plugins never are)')
      if (typeof template !== 'string') return refuse('invalid', 'template must be a string')
      change = { op: 'set-proposal-brief', kind: kind as ProposableKind, template }
      break
    }
    case 'set-comparison-param': {
      const { param, value } = input as { param: unknown; value: unknown }
      if (typeof param !== 'string' || !(IMPROVER_PARAMS as readonly string[]).includes(param)) return refuse('invalid', `param must be one of ${IMPROVER_PARAMS.join(', ')}`)
      if (param === 'selection') {
        if (!(REPLAY_SELECTIONS as readonly unknown[]).includes(value)) return refuse('out-of-bounds', `selection must be one of ${REPLAY_SELECTIONS.join(', ')}`)
      } else {
        const { min, max } = IMPROVER_PARAM_BOUNDS[param as 'selectionCases' | 'repeats']
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return refuse('out-of-bounds', `${param} must be an integer in ${min}..${max}`)
      }
      change = { op: 'set-comparison-param', param: param as ImproverParam, value: value as number | ReplaySelection }
      break
    }
  }
  const child = applyImproverChange(base, change)
  const problems = improverProblems(child)
  if (problems.length > 0) return refuse('invalid', ...problems)
  if (canonicalImproverText(child) === canonicalImproverText(base)) return refuse('no-op', 'the change leaves the improver as it is')
  return { ok: true, change, child }
}

/**
 * The free text a change adds (pure), for the instance-literal check (ADR
 * 0012 decision 5, `findInstanceLiterals`): the paragraph of
 * `set-diagnosis-paragraph`, the template of `set-proposal-brief`; the other
 * operators add none. A hit refuses the change (`instance-literal`).
 */
export function improverChangeTexts(change: ImproverChange): InstanceLiteralText[] {
  switch (change.op) {
    case 'set-diagnosis-paragraph':
      return [{ path: `diagnosis.paragraphs[${change.index}]`, text: change.text }]
    case 'set-proposal-brief':
      return [{ path: `proposal.briefs.${change.kind}`, text: change.template }]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Activation chain
// ---------------------------------------------------------------------------

/** What caused an improver revision. */
export type ImproverActivationTrigger =
  /** A meta job's comparison adopted the child. */
  | 'meta-job'
  /** The user rolled back (CLI, desktop). */
  | 'manual'
  /** The improver in force failed to load or validate; the host fell back. */
  | 'load-failure'

/** Every trigger. */
export const IMPROVER_ACTIVATION_TRIGGERS: readonly ImproverActivationTrigger[] = ['meta-job', 'manual', 'load-failure']

/**
 * `.nexgent/improvers/activation/<n>.json`, published with an exclusive hard
 * link only while revision `n - 1` is the tail (compare-and-publish, as the
 * capability chain). Never rewritten or deleted; a rollback is a new revision.
 */
export interface ImproverRevision {
  readonly format: 1
  /** 1, 2, …; equals the file's base name. */
  readonly revision: number
  /** SHA-256 of the previous revision file's exact bytes; `null` for revision 1. */
  readonly previous: string | null
  /** Improver in force before (`v0` before the first revision). */
  readonly from: ImproverVersion
  /** Improver in force after. */
  readonly version: ImproverVersion
  readonly type: 'adopt' | 'rollback'
  readonly trigger: ImproverActivationTrigger
  /** The meta job that adopted it (`adopt`, always `meta-job`). */
  readonly jobId?: string
  /** Why (`rollback`: the user's words or the load problem), at most {@link IMPROVER_LIMITS.maxReasonChars} characters. */
  readonly reason?: string
  /** ISO-8601 UTC. */
  readonly committedAt: string
}

/** The tail of the improver chain as a reader sees it. */
export interface ImproverActivationState {
  /** 0 before any revision. */
  readonly revision: number
  /** SHA-256 of the tail file's bytes; `null` at revision 0. */
  readonly digest: string | null
  /** Improver in force (`v0` at revision 0). */
  readonly version: ImproverVersion
}

/** The state before any revision. */
export const INITIAL_IMPROVER_ACTIVATION: ImproverActivationState = Object.freeze({ revision: 0, digest: null, version: IMPROVER_V0_VERSION })

/** Whether `next` may follow `state` (pure part of chain verification; the reader also checks file names and hashes). */
export function isNextImproverRevision(state: ImproverActivationState, next: ImproverRevision): boolean {
  const triggerFits = next.type === 'adopt' ? next.trigger === 'meta-job' && next.jobId !== undefined : next.trigger !== 'meta-job'
  return next.format === 1
    && next.revision === state.revision + 1
    && next.previous === state.digest
    && next.from === state.version
    && next.version !== next.from
    && IMPROVER_VERSION_PATTERN.test(next.version)
    && triggerFits
}

// ---------------------------------------------------------------------------
// Evaluator and epoch
// ---------------------------------------------------------------------------

/**
 * Id of the adoption rules in force: `decideTrial`, the gate's review and
 * feedback-check prompts and `decideImprover`. Changing any of them needs a
 * new ADR and a new id (ADR 0008 decision 5), so it starts a new epoch.
 * ADR 0013 (similar cases may not regress, instance literals are rejected)
 * replaced `adr-0008`; ADR 0014 (recorded deliverable paths follow the run's
 * own deliverables, similar cases by content words) replaced `adr-0013`;
 * ADR 0015 (feedback checks do not expect one-time extras, reviews see the
 * feedback and every changed or removed path) replaced `adr-0014`; ADR 0016
 * (each review pair asked in both orders, reviews see the task's input files)
 * replaced `adr-0015`. ADR 0019 (quality is the score on held-out practice
 * cases, combined as `combineScore`; a cheaper tie is `cost-optimized`; an
 * unreliable scorer blocks automatic skills) replaced `adr-0016`; it equals
 * `LEARNING_RULES`.
 */
export const EVALUATOR_RULES = 'adr-0019'

/**
 * What decides "better" (ADR 0008 decision 5): the rules id and the
 * project's evaluator settings. Improvers, meta jobs and models cannot write
 * any of it (`capabilities` and `improvement` are guarded config fields).
 */
export interface EvaluatorSettings {
  readonly formatVersion: 1
  readonly rules: string
  readonly costRatioCap: number
  readonly costApprovalRatio: number
  /** Guard cases per trial (at least 1). */
  readonly guardCases: number
  /** The reviewer model of reviews and feedback checks. */
  readonly reviewer: ReviewerSettings
}

/** The evaluator settings of a project's `capabilities` config (pure). */
export function evaluatorSettings(capabilities: Pick<CapabilitiesConfig, 'costRatioCap' | 'costApprovalRatio' | 'guardCases' | 'reviewer'>): EvaluatorSettings {
  return {
    formatVersion: 1,
    rules: EVALUATOR_RULES,
    costRatioCap: capabilities.costRatioCap,
    costApprovalRatio: capabilities.costApprovalRatio,
    guardCases: capabilities.guardCases,
    reviewer: { model: capabilities.reviewer.model, thinking: capabilities.reviewer.thinking },
  }
}

/** The text whose SHA-256 (UTF-8, lowercase hex) is the epoch id. */
export function canonicalEvaluatorText(settings: EvaluatorSettings): string {
  return canonicalJson(settings as unknown as JsonValue)
}

/** Pattern of an epoch id (lowercase hex SHA-256). */
export const EPOCH_PATTERN = SHA256_PATTERN

// ---------------------------------------------------------------------------
// Meta diagnosis
// ---------------------------------------------------------------------------

/** Where in past jobs a meta finding points. */
export type MetaFindingStage = 'diagnose' | 'propose' | 'trial' | 'other'

/** Every stage. */
export const META_FINDING_STAGES: readonly MetaFindingStage[] = ['diagnose', 'propose', 'trial', 'other']

/** One pattern across past jobs. */
export interface MetaFinding {
  readonly stage: MetaFindingStage
  /** Short label, e.g. "diagnoses ignore the failed checks". */
  readonly label: string
  /** The past jobs it is seen in (at least one; the host checks each exists). */
  readonly jobIds: readonly string[]
}

/** Input of `improve_report_meta_diagnosis`. */
export interface MetaDiagnosisReport {
  readonly findings: readonly MetaFinding[]
  /** One sentence: what the improver lacks. */
  readonly hypothesis: string
  /** `none`: no clear improver problem; the meta job ends `no-proposal`. */
  readonly proposal: 'change' | 'none'
}

/** `.nexgent/improvements/<jobId>/meta-diagnosis.json` (written once). */
export interface MetaDiagnosis extends MetaDiagnosisReport {
  readonly formatVersion: 1
  readonly jobId: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  readonly sessionId: string
  /** Reports asked for, 1 … {@link IMPROVER_LIMITS.maxMetaDiagnosisAttempts}. */
  readonly attempts: number
  /** The improver it diagnosed (the meta job's parent). */
  readonly improverVersion: ImproverVersion
  /** The jobs it was given (the meta job's basis). */
  readonly basis: readonly string[]
  /** Host-computed: final status counts over every finished capability job of the project. */
  readonly statusCounts: Readonly<Partial<Record<ImprovementStatus, number>>>
}

/** `.nexgent/improvements/<jobId>/change.json` (written once): the accepted proposal. */
export interface ImproverChangeRecord {
  readonly formatVersion: 1
  readonly jobId: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  readonly sessionId: string
  /** Proposals asked for, 1 … {@link IMPROVER_LIMITS.maxChangeAttempts}. */
  readonly attempts: number
  readonly parentVersion: ImproverVersion
  readonly childVersion: ImproverVersion
  readonly change: ImproverChange
  /** The model's reason, at most {@link IMPROVER_LIMITS.maxRationaleChars} characters. */
  readonly rationale: string
}

// ---------------------------------------------------------------------------
// Parent / child comparison
// ---------------------------------------------------------------------------

/**
 * How the origin was chosen (ADR 0009, superseding the origin sentence of
 * ADR 0008 decision 4), tried in this order:
 *
 * - `unresolved`: the latest finished feedback-triggered job the real job
 *   did not solve (`rejected`, `failed` or `no-proposal`, and not a job
 *   whose gate found the baseline already passing every feedback check);
 *   the arms start on the capability version that job started on.
 * - `feedback-version`: none such; the latest finished feedback-triggered
 *   job, the arms starting on the capability version its feedback task ran
 *   on (the problem still present).
 */
export type ComparisonOriginKind = 'unresolved' | 'feedback-version'

/** Every origin kind, in the order they are tried. */
export const COMPARISON_ORIGIN_KINDS: readonly ComparisonOriginKind[] = ['unresolved', 'feedback-version']

/**
 * The common start of both arms (ADR 0008 decision 4, ADR 0009): how it
 * was chosen, the snapshot tree of the source job's feedback task, its
 * feedback ids (sorted), the capability version the arms start on and the
 * epoch. Each arm records what it found in its own copy; arms that differ
 * (in any field, `kind` included) are not compared.
 */
export interface ComparisonOrigin {
  readonly kind: ComparisonOriginKind
  /** The source job (see {@link ComparisonOriginKind}). */
  readonly sourceJobId: string
  /** Snapshot tree id (`snapshots/trees/<sha256>.json`). */
  readonly tree: string
  readonly feedbackIds: readonly string[]
  readonly capabilityVersion: CapabilityVersion
  readonly epoch: string
  /** ADR 0012: the project of the source job (the arms run in its copies); absent for a project-level meta job. */
  readonly projectId?: string
}

/** Total spend of one arm's job (diagnose + propose + trial), with the display dollars. */
export interface ArmCost extends PhaseCost {
  /** From `@nexgent/llm`'s price table; `unknown` when any usage or price is. */
  readonly estimatedUsd: number | 'unknown'
}

/** One arm's job as the comparison reads it (its job record lives in the arm's copy). */
export interface ComparisonArmResult {
  readonly arm: ComparisonArm
  readonly improverVersion: ImproverVersion
  /** What the arm found at its start. */
  readonly origin: ComparisonOrigin
  /** The arm's job id (in the copy). */
  readonly jobId: string
  /** The arm job's last status. */
  readonly status: ImprovementStatus
  /** The arm job's error, when it failed. */
  readonly error?: ErrorInfo
  /** The offspring: the candidate its propose phase produced. */
  readonly candidateId?: string
  /** The gate's verdict on the offspring, when a trial ended. */
  readonly verdict?: TrialVerdict
  readonly cost: ArmCost
}

/** A kept comparison copy (experiments only). */
export interface KeptCopy {
  /** Absolute root of the copy. */
  readonly root: string
  readonly bytes: number
}

/** Why `decideImprover` concluded as it did. */
export type ImproverDecisionReason =
  | 'gate-passed'
  | 'quality-up'
  | 'cost-down'
  | 'no-improvement'
  | 'no-offspring'
  | 'unknown-arm'
  | 'origin-mismatch'
  | 'epoch-mismatch'

/** Every reason. */
export const IMPROVER_DECISION_REASONS: readonly ImproverDecisionReason[] = [
  'gate-passed', 'quality-up', 'cost-down', 'no-improvement', 'no-offspring', 'unknown-arm', 'origin-mismatch', 'epoch-mismatch',
]

/** The comparison's conclusion. */
export interface ImproverVerdict {
  readonly outcome: 'adopt' | 'reject'
  readonly reason: ImproverDecisionReason
  /** Each arm's offspring quality (the gate's candidate pass rate), when both passed their gate. */
  readonly quality?: { readonly parent: number; readonly child: number }
  /** Child / parent estimated dollars, when both are known and the parent's is above 0. */
  readonly costRatio?: number
}

/** `.nexgent/improvements/<jobId>/comparison.json` (written once, when the verdict is in). */
export interface ImproverComparison {
  readonly formatVersion: 1
  /** The meta job. */
  readonly jobId: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  /** The origin the host prepared for both copies. */
  readonly origin: ComparisonOrigin
  readonly parent: ComparisonArmResult
  readonly child: ComparisonArmResult
  readonly verdict: ImproverVerdict
  /** Experiments only: the copies kept after the decision. */
  readonly kept?: { readonly parent?: KeptCopy; readonly child?: KeptCopy }
}

/** A child cheaper than this fraction of the parent wins a quality tie (ADR 0008 decision 4: at least 10% less). */
export const IMPROVER_COST_DOWN_RATIO = 0.9

const ARM_UNKNOWN_STATUSES: readonly ImprovementStatus[] = ['budget-exhausted', 'interrupted', 'cancelled']
const IMPROVER_FAILURE_CODES: readonly string[] = ['improvement/invalid-diagnosis']

/**
 * How one arm reads (pure). `unknown`: the job did not finish, was
 * interrupted, cancelled or out of budget, failed on an error other than its
 * own invalid diagnosis, its trial ended `unknown-runs` / `budget-exhausted`,
 * or its cost is unknown. A failure without such an error (no candidate
 * proposed, diagnosis refused three times) is the improver's own result:
 * no offspring, not unknown.
 */
export function armOutcome(arm: ComparisonArmResult): { readonly unknown: boolean; readonly offspring: boolean; readonly gatePassed: boolean; readonly quality?: number } {
  const errored = arm.status === 'failed' && arm.error !== undefined && !IMPROVER_FAILURE_CODES.includes(arm.error.code)
  const trialUnknown = arm.verdict !== undefined && (arm.verdict.reason === 'unknown-runs' || arm.verdict.reason === 'budget-exhausted')
  const unknown = !isFinalImprovementStatus(arm.status) || ARM_UNKNOWN_STATUSES.includes(arm.status) || errored || trialUnknown || arm.cost.estimatedUsd === 'unknown'
  const gatePassed = arm.status === 'adopted'
  return {
    unknown,
    offspring: arm.candidateId !== undefined,
    gatePassed,
    ...(gatePassed && arm.verdict !== undefined ? { quality: arm.verdict.passRate.candidate } : {}),
  }
}

function sameOrigin(left: ComparisonOrigin, right: ComparisonOrigin): boolean {
  const key = (origin: ComparisonOrigin) => canonicalJson({ ...origin, feedbackIds: [...origin.feedbackIds].sort() } as unknown as JsonValue)
  return key(left) === key(right)
}

/**
 * The comparison rule (ADR 0008 decision 4), pure, in order:
 *
 * 1. The arms' epochs differ from each other or from the prepared origin:
 *    reject (`epoch-mismatch`); any other origin difference: reject
 *    (`origin-mismatch`).
 * 2. Any arm unknown ({@link armOutcome}): reject (`unknown-arm`).
 * 3. The child produced no offspring: reject (`no-offspring`).
 * 4. The child's offspring passed its gate and the parent's did not: adopt
 *    (`gate-passed`).
 * 5. Only when both offspring passed their gates: higher child quality
 *    adopts (`quality-up`); equal quality and a child cost at most
 *    {@link IMPROVER_COST_DOWN_RATIO} of the parent's (exactly 10% less
 *    counts) adopts (`cost-down`). Quality and cost never decide when only
 *    the parent passed or neither did.
 * 6. Anything else rejects (`no-improvement`).
 */
export function decideImprover(origin: ComparisonOrigin, parent: ComparisonArmResult, child: ComparisonArmResult): ImproverVerdict {
  if (parent.origin.epoch !== child.origin.epoch || parent.origin.epoch !== origin.epoch) return { outcome: 'reject', reason: 'epoch-mismatch' }
  if (!sameOrigin(parent.origin, origin) || !sameOrigin(child.origin, origin)) return { outcome: 'reject', reason: 'origin-mismatch' }
  const p = armOutcome(parent)
  const c = armOutcome(child)
  if (p.unknown || c.unknown) return { outcome: 'reject', reason: 'unknown-arm' }
  if (!c.offspring) return { outcome: 'reject', reason: 'no-offspring' }
  if (c.gatePassed && !p.gatePassed) return { outcome: 'adopt', reason: 'gate-passed' }
  if (!(c.gatePassed && p.gatePassed) || c.quality === undefined || p.quality === undefined) return { outcome: 'reject', reason: 'no-improvement' }
  const quality = { parent: p.quality, child: c.quality }
  const parentUsd = parent.cost.estimatedUsd as number
  const childUsd = child.cost.estimatedUsd as number
  const costRatio = parentUsd > 0 ? childUsd / parentUsd : undefined
  const verdict = (outcome: 'adopt' | 'reject', reason: ImproverDecisionReason): ImproverVerdict => ({ outcome, reason, quality, ...(costRatio === undefined ? {} : { costRatio }) })
  if (c.quality > p.quality) return verdict('adopt', 'quality-up')
  // Exactly 10% less counts (child ≤ 0.9 × parent), compared as products so a ratio's rounding cannot decide.
  if (c.quality === p.quality && parentUsd > 0 && childUsd <= parentUsd * IMPROVER_COST_DOWN_RATIO) return verdict('adopt', 'cost-down')
  return verdict('reject', 'no-improvement')
}

// ---------------------------------------------------------------------------
// Meta-job session tools
// ---------------------------------------------------------------------------

const id: JsonSchema = { type: 'string', minLength: 1 }

/**
 * ADR 0012 decision 4: the project a meta-session read is about. Only the
 * projects of the meta job's batch are accepted (the host refuses any other
 * id, and any project that turned `shareImproverEvidence` off); the ids are
 * listed in the session's first message and by `improve_list_jobs`.
 */
const projectId: JsonSchema = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'A project of this meta job\'s batch (its id as improve_list_jobs shows it).' }

/** A meta-session copy of a read tool with the `projectId` parameter (required, or optional with the batch's newest project as default). */
function withProject(tool: ImprovementToolSpec, required: boolean): ImprovementToolSpec {
  const schema = tool.inputSchema as { readonly properties?: Record<string, JsonSchema>; readonly required?: readonly string[] }
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...schema.properties, projectId },
      ...(required ? { required: [...(schema.required ?? []), 'projectId'] } : {}),
    },
  }
}

/** `improve_list_jobs`: the finished and running jobs of the batch's projects (one project with `projectId`), one summary line each (project, status, trigger, diagnosis kind, verdict, cost, first use, rollback). */
export const IMPROVE_LIST_JOBS_TOOL: ImprovementToolSpec = {
  name: 'improve_list_jobs',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId,
      statuses: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Only jobs with these statuses.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
}

/** `improve_read_job`: one job's record, diagnosis, candidate summary and gate verdict; `projectId` may be left out when the job id is in the batch. */
export const IMPROVE_READ_JOB_TOOL: ImprovementToolSpec = {
  name: 'improve_read_job',
  effects: ['read'],
  approval: 'never',
  inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: id, projectId } },
}

/** ADR 0012: `improve_read_session` in a meta-diagnose session: the same slice, of a session of one batch project. */
export const META_READ_SESSION_TOOL: ImprovementToolSpec = withProject(IMPROVE_READ_SESSION_TOOL, true)

/** ADR 0012: `improve_read_ledger` in a meta-diagnose session: the same slice, of one batch project's ledger. */
export const META_READ_LEDGER_TOOL: ImprovementToolSpec = withProject(IMPROVE_READ_LEDGER_TOOL, true)

/**
 * `improve_report_meta_diagnosis`: submit the meta diagnosis. The host
 * checks the schema and that every cited job exists; a refused report may be
 * resubmitted, up to {@link IMPROVER_LIMITS.maxMetaDiagnosisAttempts} in total.
 */
export const IMPROVE_REPORT_META_DIAGNOSIS_TOOL: ImprovementToolSpec = {
  name: 'improve_report_meta_diagnosis',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'hypothesis', 'proposal'],
    properties: {
      findings: {
        type: 'array',
        maxItems: IMPROVER_LIMITS.maxFindings,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['stage', 'label', 'jobIds'],
          properties: {
            stage: { enum: [...META_FINDING_STAGES] },
            label: { type: 'string', minLength: 1, maxLength: IMPROVER_LIMITS.maxLabelChars },
            jobIds: { type: 'array', minItems: 1, maxItems: IMPROVER_LIMITS.maxFindingJobs, items: id },
          },
        },
      },
      hypothesis: { type: 'string', minLength: 1, maxLength: IMPROVER_LIMITS.maxHypothesisChars },
      proposal: { enum: ['change', 'none'] },
    },
  },
}

/** `improve_read_improver`: the improver in force (the parent) as JSON, with the change operators and bounds. */
export const IMPROVE_READ_IMPROVER_TOOL: ImprovementToolSpec = {
  name: 'improve_read_improver',
  effects: ['read'],
  approval: 'never',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}

/**
 * `improve_propose_change`: submit exactly one {@link ImproverChange} and
 * why. The host runs {@link checkImproverChange}; a refused change may be
 * resubmitted, up to {@link IMPROVER_LIMITS.maxChangeAttempts} in total.
 */
export const IMPROVE_PROPOSE_CHANGE_TOOL: ImprovementToolSpec = {
  name: 'improve_propose_change',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['change', 'rationale'],
    properties: {
      change: {
        type: 'object',
        description: 'Exactly one change: {op: "set-diagnosis-paragraph", index, text} | {op: "set-proposal-kinds", kinds} | {op: "set-proposal-brief", kind, template} | {op: "set-comparison-param", param, value}.',
        required: ['op'],
        properties: {
          op: { enum: [...IMPROVER_CHANGE_OPS] },
          index: { type: 'integer', minimum: 0 },
          text: { type: 'string', minLength: 1, maxLength: IMPROVER_LIMITS.maxParagraphChars },
          kinds: { type: 'array', items: { enum: [...PROPOSABLE_KINDS] } },
          kind: { enum: [...PROPOSABLE_KINDS] },
          template: { type: 'string', minLength: 1, maxLength: IMPROVER_LIMITS.maxBriefChars },
          param: { enum: [...IMPROVER_PARAMS] },
          value: { type: ['integer', 'string'] },
        },
      },
      rationale: { type: 'string', minLength: 1, maxLength: IMPROVER_LIMITS.maxRationaleChars },
    },
  },
}

/**
 * The tools of a meta-diagnose session, and nothing else (read-only: past
 * jobs, sessions, ledger, plus the report).
 */
export const META_DIAGNOSIS_TOOLS: readonly ImprovementToolSpec[] = [
  IMPROVE_LIST_JOBS_TOOL,
  IMPROVE_READ_JOB_TOOL,
  META_READ_SESSION_TOOL,
  META_READ_LEDGER_TOOL,
  IMPROVE_REPORT_META_DIAGNOSIS_TOOL,
]

/** The tools of a meta-propose session, and nothing else: read the parent and past jobs, propose one change. */
export const META_PROPOSE_TOOLS: readonly ImprovementToolSpec[] = [
  IMPROVE_READ_IMPROVER_TOOL,
  IMPROVE_READ_JOB_TOOL,
  IMPROVE_PROPOSE_CHANGE_TOOL,
]
