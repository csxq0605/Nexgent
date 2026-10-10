/**
 * Acceptance summary JSON: its schema (fields mirror the sections of
 * `docs/validation/TEMPLATE.md`), a builder for acceptance scripts, and a
 * validator. Convention from the template: "none" is an empty array or
 * `null`; "don't know" is the string `'unknown'`.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { release, type as osType } from 'node:os'
import type { LedgerRecord } from '@nexgent/kernel'
import { ledgerStats, type LedgerStats } from './records.js'

/** Identifier stored in every summary's `kind` field. */
export const ACCEPTANCE_SUMMARY_KIND = 'nexgent.acceptance-summary'

/** Current summary schema version. */
export const ACCEPTANCE_SUMMARY_VERSION = 1

/** One check an acceptance script made. */
export interface AcceptanceCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
  readonly durationMs?: number
}

/** Count or `'unknown'`. */
export type CountOrUnknown = number | 'unknown'

/** The summary document (one platform, one run). */
export interface AcceptanceSummary {
  readonly kind: typeof ACCEPTANCE_SUMMARY_KIND
  readonly schemaVersion: typeof ACCEPTANCE_SUMMARY_VERSION
  /** Overall result: `pass` iff there is at least one check and all passed. */
  readonly result: 'pass' | 'fail'
  /** Template "步骤". */
  readonly step: {
    readonly number: number
    readonly name: string
    readonly exitCriteria: readonly string[]
    /** Acceptance script path, or `null` with `scriptNote` saying why there is none. */
    readonly script: string | null
    readonly scriptNote?: string
  }
  /** Template "日期". */
  readonly date: {
    /** ISO-8601 UTC timestamp of the run. */
    readonly acceptedAt: string
    readonly commitRange: { readonly from: string; readonly to: string } | null
  }
  /** Template "分支与提交". */
  readonly source: {
    readonly branch: string
    readonly commit: string
    readonly pullRequests: readonly string[]
  }
  /** Template "环境" (the platform this run executed on). */
  readonly environment: {
    readonly platform: string
    readonly os: string
    readonly node: string
    readonly pnpm: string
    readonly other: Readonly<Record<string, string>>
  }
  /** Template "脚本化 provider 结果"; `null` for a real-model-only run. */
  readonly scripted: {
    readonly command: string
    readonly ciRunUrl: string | null
    readonly result: 'pass' | 'fail'
    readonly summaryFile: string | null
    /** What the script simulated. */
    readonly simulated: string
    /** Faults injected (e.g. `network-down`, `timeout`, `kill`, `truncate`). */
    readonly faultsInjected: readonly string[]
  } | null
  /** Template "真实模型结果"; `null` when no real model was used. */
  readonly realModel: {
    readonly model: string
    readonly thinking: 'off' | 'on'
    readonly task: string
    readonly callCount: CountOrUnknown
    readonly knownTokens: { readonly input: CountOrUnknown; readonly output: CountOrUnknown }
    readonly unknownCount: CountOrUnknown
    readonly cost: number | 'unknown'
    readonly result: 'pass' | 'fail'
    readonly summaryFile: string | null
    readonly runNote: string
    readonly unknownSources: readonly string[]
  } | null
  /** Individual checks. */
  readonly checks: readonly AcceptanceCheck[]
  /** Ledger facts for the run (`writeFailures` must be reported, per data-formats.md). */
  readonly ledger: (LedgerStats & { readonly writeFailures: CountOrUnknown }) | null
  /** Template "失败与缺测". */
  readonly failures: {
    readonly failedCases: readonly string[]
    readonly untested: readonly string[]
    readonly knownIssues: readonly string[]
  }
  /** Template "结论边界". */
  readonly conclusion: {
    readonly proves: readonly string[]
    readonly doesNotProve: readonly string[]
    readonly meetsExitCriteria: boolean
    readonly missing: readonly string[]
  }
  /** Template "原始记录位置与 manifest 摘要". */
  readonly raw: {
    readonly location: string | null
    readonly sha256: string | null
    readonly summaryDir: string | null
    readonly manifest: ReadonlyArray<{ readonly sha256: string; readonly file: string }>
  }
}

// ---------------------------------------------------------------------------
// Schema (JSON Schema draft 2020-12 subset understood by the validator below)
// ---------------------------------------------------------------------------

const str = { type: 'string' } as const
const strOrNull = { type: ['string', 'null'] } as const
const strList = { type: 'array', items: str } as const
const countOrUnknown = { anyOf: [{ type: 'integer', minimum: 0 }, { const: 'unknown' }] } as const
const passFail = { enum: ['pass', 'fail'] } as const
const obj = (properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties)): Record<string, unknown> => ({
  type: 'object', properties, required, additionalProperties: false,
})

/** JSON Schema of {@link AcceptanceSummary}. */
export const ACCEPTANCE_SUMMARY_SCHEMA: Readonly<Record<string, unknown>> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schemas/acceptance-summary.v1.json',
  title: 'Nexgent acceptance summary',
  ...obj({
    kind: { const: ACCEPTANCE_SUMMARY_KIND },
    schemaVersion: { const: ACCEPTANCE_SUMMARY_VERSION },
    result: passFail,
    step: obj({
      number: { type: 'integer', minimum: 0 },
      name: { type: 'string', minLength: 1 },
      exitCriteria: strList,
      script: strOrNull,
      scriptNote: str,
    }, ['number', 'name', 'exitCriteria', 'script']),
    date: obj({
      acceptedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' },
      commitRange: { anyOf: [{ type: 'null' }, obj({ from: str, to: str })] },
    }),
    source: obj({ branch: { type: 'string', minLength: 1 }, commit: { type: 'string', minLength: 1 }, pullRequests: strList }),
    environment: obj({
      platform: { type: 'string', minLength: 1 },
      os: str,
      node: str,
      pnpm: str,
      other: { type: 'object', additionalProperties: str },
    }),
    scripted: {
      anyOf: [{ type: 'null' }, obj({
        command: { type: 'string', minLength: 1 },
        ciRunUrl: strOrNull,
        result: passFail,
        summaryFile: strOrNull,
        simulated: str,
        faultsInjected: strList,
      })],
    },
    realModel: {
      anyOf: [{ type: 'null' }, obj({
        model: { type: 'string', minLength: 1 },
        thinking: { enum: ['off', 'on'] },
        task: str,
        callCount: countOrUnknown,
        knownTokens: obj({ input: countOrUnknown, output: countOrUnknown }),
        unknownCount: countOrUnknown,
        cost: { anyOf: [{ type: 'number', minimum: 0 }, { const: 'unknown' }] },
        result: passFail,
        summaryFile: strOrNull,
        runNote: str,
        unknownSources: strList,
      })],
    },
    checks: {
      type: 'array',
      items: obj({
        name: { type: 'string', minLength: 1 },
        passed: { type: 'boolean' },
        detail: str,
        durationMs: { type: 'number', minimum: 0 },
      }, ['name', 'passed']),
    },
    ledger: {
      anyOf: [{ type: 'null' }, obj({
        requestCount: { type: 'integer', minimum: 0 },
        statusCounts: obj({
          ok: { type: 'integer', minimum: 0 },
          error: { type: 'integer', minimum: 0 },
          aborted: { type: 'integer', minimum: 0 },
          unknown: { type: 'integer', minimum: 0 },
        }),
        unknownUsageCount: { type: 'integer', minimum: 0 },
        knownInputTokens: { type: 'integer', minimum: 0 },
        knownOutputTokens: { type: 'integer', minimum: 0 },
        toolCallCount: { type: 'integer', minimum: 0 },
        taskOutcomes: { type: 'integer', minimum: 0 },
        writeFailures: countOrUnknown,
      })],
    },
    failures: obj({ failedCases: strList, untested: strList, knownIssues: strList }),
    conclusion: obj({ proves: strList, doesNotProve: strList, meetsExitCriteria: { type: 'boolean' }, missing: strList }),
    raw: obj({
      location: strOrNull,
      sha256: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9a-f]{64}$' }] },
      summaryDir: strOrNull,
      manifest: { type: 'array', items: obj({ sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, file: str }) },
    }),
  }),
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/** Validation outcome; `errors` holds `<json-pointer>: <problem>` lines. */
export interface ValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function check(schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  const at = path === '' ? '/' : path
  if ('anyOf' in schema) {
    const options = schema['anyOf'] as Record<string, unknown>[]
    const results = options.map((option) => {
      const sub: string[] = []
      check(option, value, path, sub)
      return sub
    })
    if (!results.some((r) => r.length === 0)) {
      // Report the branch that got furthest (fewest errors).
      const best = results.reduce((a, b) => (b.length < a.length ? b : a))
      errors.push(...best)
    }
    return
  }
  if ('const' in schema && value !== schema['const']) {
    errors.push(`${at}: must be ${JSON.stringify(schema['const'])}`)
    return
  }
  if ('enum' in schema && !(schema['enum'] as unknown[]).includes(value)) {
    errors.push(`${at}: must be one of ${JSON.stringify(schema['enum'])}`)
    return
  }
  if ('type' in schema) {
    const wanted = ([] as string[]).concat(schema['type'] as string | string[])
    const actual = typeOf(value)
    if (!wanted.includes(actual) && !(actual === 'integer' && wanted.includes('number'))) {
      errors.push(`${at}: must be ${wanted.join(' or ')}, got ${actual}`)
      return
    }
  }
  if (typeof value === 'number' && typeof schema['minimum'] === 'number' && value < schema['minimum']) {
    errors.push(`${at}: must be >= ${schema['minimum']}`)
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) errors.push(`${at}: must not be empty`)
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) {
      errors.push(`${at}: must match ${schema['pattern']}`)
    }
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    value.forEach((item, i) => check(schema['items'] as Record<string, unknown>, item, `${path}/${i}`, errors))
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>
    const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>
    for (const key of (schema['required'] ?? []) as string[]) {
      if (!(key in record) || record[key] === undefined) errors.push(`${path}/${key}: is required`)
    }
    for (const [key, item] of Object.entries(record)) {
      if (item === undefined) continue
      const sub = properties[key]
      if (sub !== undefined) check(sub, item, `${path}/${key}`, errors)
      else if (schema['additionalProperties'] === false) errors.push(`${path}/${key}: is not allowed`)
      else if (typeof schema['additionalProperties'] === 'object') {
        check(schema['additionalProperties'] as Record<string, unknown>, item, `${path}/${key}`, errors)
      }
    }
  }
}

/**
 * Validate a value against {@link ACCEPTANCE_SUMMARY_SCHEMA}, plus the
 * cross-field rule that `result` agrees with `checks`.
 * @param value - parsed JSON.
 */
export function validateAcceptanceSummary(value: unknown): ValidationResult {
  const errors: string[] = []
  check(ACCEPTANCE_SUMMARY_SCHEMA as Record<string, unknown>, value, '', errors)
  if (errors.length === 0) {
    const summary = value as AcceptanceSummary
    const expected = summary.checks.length > 0 && summary.checks.every((c) => c.passed) ? 'pass' : 'fail'
    if (summary.result !== expected) errors.push(`/result: must be "${expected}" given checks`)
  }
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** What an acceptance script knows up front. */
export interface AcceptanceSummaryInit {
  /** Step number, e.g. 1. */
  readonly step: number
  /** Step name, e.g. `本地执行内核`. */
  readonly name: string
  readonly exitCriteria?: readonly string[]
  /** Acceptance script path, e.g. `scripts/accept-step1.mjs`. */
  readonly script?: string | null
  /** Command line that ran the script (scripted runs). */
  readonly command?: string
  /** What the run simulated (scripted runs). */
  readonly simulated?: string
  /** `scripted` (default) fills `scripted`; `real` leaves it null for `set({ realModel })`. */
  readonly provider?: 'scripted' | 'real'
  /** Directory used to ask git for branch/commit when CI env vars are absent (default cwd). */
  readonly repoRoot?: string
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Fluent builder returned by {@link acceptanceSummary}. */
export interface AcceptanceSummaryBuilder {
  /** Record a check. */
  check(name: string, passed: boolean, detail?: string): AcceptanceSummaryBuilder
  /**
   * Run `fn` as a named check, timing it. A throw records a failed check
   * (detail = error message) and is rethrown.
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>
  /** Note an injected fault kind (`network-down`, `timeout`, `kill`, `truncate`, …). */
  fault(kind: string): AcceptanceSummaryBuilder
  /** Attach ledger stats (from records or precomputed). */
  ledger(records: readonly LedgerRecord[] | LedgerStats, writeFailures?: CountOrUnknown): AcceptanceSummaryBuilder
  /** Shallow-merge top-level sections (each given section replaces the default wholesale, except `failures`/`conclusion` lists which are merged in). */
  set(patch: Partial<Omit<AcceptanceSummary, 'kind' | 'schemaVersion' | 'result' | 'checks'>>): AcceptanceSummaryBuilder
  /** Note something not tested. */
  untested(text: string): AcceptanceSummaryBuilder
  /** Note a known, unfixed issue. */
  knownIssue(text: string): AcceptanceSummaryBuilder
  /** Note what the run proves / does not prove. */
  proves(text: string): AcceptanceSummaryBuilder
  doesNotProve(text: string): AcceptanceSummaryBuilder
  /** Produce the summary (results derived from checks). */
  build(): AcceptanceSummary
  /** Build, validate (throws on invalid), write pretty JSON + newline to `path`, return the summary. */
  write(path: string): Promise<AcceptanceSummary>
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined
  } catch {
    return undefined
  }
}

/** Detect the current environment section. */
export function detectEnvironment(): AcceptanceSummary['environment'] {
  const agent = process.env['npm_config_user_agent'] ?? ''
  const pnpm = /pnpm\/(\S+)/.exec(agent)?.[1] ?? 'unknown'
  return { platform: process.platform, os: `${osType()} ${release()}`, node: process.version, pnpm, other: {} }
}

/**
 * Start an acceptance summary. Branch / commit / CI run URL come from
 * GitHub Actions env vars when present, else from `git`, else `'unknown'`.
 * @param init - step facts.
 */
export function acceptanceSummary(init: AcceptanceSummaryInit): AcceptanceSummaryBuilder {
  const env = process.env
  const cwd = init.repoRoot ?? process.cwd()
  const ciRunUrl = env['GITHUB_RUN_ID'] !== undefined && env['GITHUB_REPOSITORY'] !== undefined
    ? `${env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${env['GITHUB_REPOSITORY']}/actions/runs/${env['GITHUB_RUN_ID']}`
    : null
  const checks: AcceptanceCheck[] = []
  const faults: string[] = []
  const state: Mutable<Omit<AcceptanceSummary, 'kind' | 'schemaVersion' | 'result' | 'checks'>> = {
    step: { number: init.step, name: init.name, exitCriteria: [...(init.exitCriteria ?? [])], script: init.script ?? null },
    date: { acceptedAt: new Date().toISOString(), commitRange: null },
    source: {
      branch: env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME'] || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || 'unknown',
      commit: env['GITHUB_SHA'] || git(['rev-parse', 'HEAD'], cwd) || 'unknown',
      pullRequests: [],
    },
    environment: detectEnvironment(),
    scripted: (init.provider ?? 'scripted') === 'scripted'
      ? {
        command: init.command ?? (init.script ? `node ${init.script}` : 'unknown'),
        ciRunUrl,
        result: 'fail',
        summaryFile: null,
        simulated: init.simulated ?? '',
        faultsInjected: faults,
      }
      : null,
    realModel: null,
    ledger: null,
    failures: { failedCases: [], untested: [], knownIssues: [] },
    conclusion: { proves: [], doesNotProve: [], meetsExitCriteria: false, missing: [] },
    raw: { location: null, sha256: null, summaryDir: null, manifest: [] },
  }
  let meetsOverride: boolean | undefined
  const lists = {
    untested: [] as string[],
    knownIssues: [] as string[],
    proves: [] as string[],
    doesNotProve: [] as string[],
  }

  const builder: AcceptanceSummaryBuilder = {
    check(name, passed, detail) {
      checks.push(detail === undefined ? { name, passed } : { name, passed, detail })
      return builder
    },
    async run(name, fn) {
      const started = Date.now()
      try {
        const value = await fn()
        checks.push({ name, passed: true, durationMs: Date.now() - started })
        return value
      } catch (error) {
        checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
        throw error
      }
    },
    fault(kind) {
      if (!faults.includes(kind)) faults.push(kind)
      return builder
    },
    ledger(records, writeFailures = 'unknown') {
      const stats = Array.isArray(records) ? ledgerStats(records as readonly LedgerRecord[]) : records as LedgerStats
      state.ledger = { ...stats, writeFailures }
      return builder
    },
    set(patch) {
      const { failures, conclusion, scripted, ...rest } = patch
      Object.assign(state, rest)
      if (scripted !== undefined) {
        state.scripted = scripted === null ? null : { ...scripted, faultsInjected: [...new Set([...scripted.faultsInjected, ...faults])] }
      }
      if (failures !== undefined) {
        lists.untested.push(...failures.untested)
        lists.knownIssues.push(...failures.knownIssues)
        state.failures = { ...state.failures, failedCases: [...state.failures.failedCases, ...failures.failedCases] }
      }
      if (conclusion !== undefined) {
        lists.proves.push(...conclusion.proves)
        lists.doesNotProve.push(...conclusion.doesNotProve)
        meetsOverride = conclusion.meetsExitCriteria
        state.conclusion = { ...state.conclusion, missing: [...state.conclusion.missing, ...conclusion.missing] }
      }
      return builder
    },
    untested(text) { lists.untested.push(text); return builder },
    knownIssue(text) { lists.knownIssues.push(text); return builder },
    proves(text) { lists.proves.push(text); return builder },
    doesNotProve(text) { lists.doesNotProve.push(text); return builder },
    build() {
      const result = checks.length > 0 && checks.every((c) => c.passed) ? 'pass' : 'fail'
      const failed = checks.filter((c) => !c.passed).map((c) => (c.detail === undefined ? c.name : `${c.name}: ${c.detail}`))
      return {
        kind: ACCEPTANCE_SUMMARY_KIND,
        schemaVersion: ACCEPTANCE_SUMMARY_VERSION,
        result,
        ...state,
        scripted: state.scripted === null ? null : { ...state.scripted, result, faultsInjected: [...new Set([...state.scripted.faultsInjected, ...faults])] },
        checks: [...checks],
        failures: {
          failedCases: [...state.failures.failedCases, ...failed],
          untested: [...lists.untested],
          knownIssues: [...lists.knownIssues],
        },
        conclusion: {
          proves: [...lists.proves],
          doesNotProve: [...lists.doesNotProve],
          meetsExitCriteria: meetsOverride ?? result === 'pass',
          missing: [...state.conclusion.missing],
        },
      }
    },
    async write(path) {
      const summary = builder.build()
      const { valid, errors } = validateAcceptanceSummary(summary)
      if (!valid) throw new Error(`invalid acceptance summary:\n${errors.join('\n')}`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
      return summary
    },
  }
  return builder
}
