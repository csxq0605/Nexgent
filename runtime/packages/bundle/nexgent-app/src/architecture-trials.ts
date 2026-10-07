/** Host-frozen paired output trials over the application's native workflow engine. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadArchitecture, prepareOutputTrialArchitecture, saveArchitecture } from '@deepseek-ai/dsh-tool-workflow'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowRun } from '@deepseek-ai/dsh-workflow'
import type {} from './execution-ledger.ts'

/** Identity minted by the host for one paired evaluation, never an adoption token. */
export type ArchitectureTrialId = Branded<'NexgentArchitectureTrialId'>

/** Deployment-owned trial configuration; no criteria arrive through model calls. */
export interface Config {
  /** Absolute saved-definition directory shared with the application's workflow tool. */
  architectureDirectory: string
  /** Absolute directory for exclusive synchronized trial receipts. */
  receiptDirectory: string
  /** Host JSON plans: {id,description,baseline,cases:[{id,input,outputNode,expected}]}. */
  plans?: unknown[]
  /** Per-case execution deadline in milliseconds (default 180000). */
  maxCaseMs?: number
  /** Total member cap for each case (default 32, bounded by the workflow engine). */
  maxTotalAgents?: number
}

export const Config: z<Config> = z.object({
  architectureDirectory: z.string(),
  receiptDirectory: z.string(),
  plans: z.array(z.any()).default([]),
  maxCaseMs: z.natural().min(1).max(2_147_483_647).default(180_000),
  maxTotalAgents: z.natural().min(1).default(32),
})

export const name = 'nexgent-architecture-trials'
export const inject = ['tools', 'workflowEngine', 'systemPrompt', 'executionLedger']

interface TrialCase { id: string; input: JsonValue; outputNode: string; expected: JsonValue }
interface TrialPlan {
  id: string
  description: string
  baseline: ReturnType<typeof prepareOutputTrialArchitecture>
  cases: TrialCase[]
  digest: string
}
interface CaseResult {
  arm: 'baseline' | 'candidate'
  caseId: string
  status: 'pass' | 'fail' | 'unknown'
  reason?: 'not-run' | 'cancelled' | 'execution-error' | 'missing-output' | 'cleanup-error'
  runId?: WorkflowRun['id']
  agentsStarted?: number
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalid output trial plan fields')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('output trial fields require non-empty strings')
  return value
}

function json(value: unknown): JsonValue {
  const copied = snapshotJsonValue(value)
  if (copied === undefined) throw new Error('output trial criteria require lossless JSON')
  return copied as JsonValue
}

function readPlans(values: unknown[]): Map<string, TrialPlan> {
  const plans = new Map<string, TrialPlan>()
  for (const value of values) {
    const row = record(value, ['id', 'description', 'baseline', 'cases'])
    const id = text(row.id)
    if (plans.has(id)) throw new Error('output trial plan ids must be unique')
    const baseline = prepareOutputTrialArchitecture(row.baseline)
    if (!Array.isArray(row.cases) || row.cases.length === 0) throw new Error('output trial plans require cases')
    const cases = row.cases.map((item: unknown): TrialCase => {
      const data = record(item, ['id', 'input', 'outputNode', 'expected'])
      const outputNode = text(data.outputNode)
      if (!baseline.architecture.nodes.some(node => node.id === outputNode)) throw new Error('output trial node is missing from baseline')
      return { id: text(data.id), input: json(data.input), outputNode, expected: json(data.expected) }
    })
    if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('output trial case ids must be unique')
    const description = text(row.description)
    const digest = createHash('sha256').update(JSON.stringify({ format: 1, id, description, baseline: baseline.version, cases })).digest('hex')
    plans.set(id, { id, description, baseline, cases, digest })
  }
  return plans
}

/**
 * Install a paired-trial consumer with criteria detached at composition time.
 * Empty plans expose no model tool. Every started native run is drained before
 * its receipt reports a case outcome; unloading cancels and drains active calls.
 * @param ctx - application-owned native tool and workflow context.
 * @param config - validated host configuration and frozen JSON criteria.
 */
export function apply(ctx: Context, config: Config): void {
  const { architectureDirectory, receiptDirectory, plans: values, maxCaseMs, maxTotalAgents } = config as Required<Config>
  if (!isAbsolute(architectureDirectory) || !isAbsolute(receiptDirectory)) throw new Error('output trial directories must be absolute')
  const plans = readPlans(values)
  if (plans.size === 0) return
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  })
  ctx.systemPrompt.section({
    name: 'tool:architecture_trial',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: 'Use architecture_trial to compare an output-only candidate with a host-frozen baseline. A pass is case evidence, not adoption or an improvement claim.',
  })
  ctx.tools.register(defineTool({
    name: 'architecture_trial',
    description: `Compare a candidate graph with a frozen baseline on the host's input cases. Supply exactly one of architecture or architectureVersion, plus planId. Every member's global tools are disabled; scoped structured output remains. The host compares actual node outputs with frozen JSON values. Execution, cancellation and cleanup failures remain unknown. No case answers can be supplied or changed here. Plans: ${JSON.stringify([...plans.values()].map(plan => ({ id: plan.id, description: plan.description })))}. Results do not adopt a version, measure paid cost or establish general improvement.`,
    parameters: {
      planId: { type: 'string', required: true, description: 'Host-registered plan identity.' },
      architecture: { type: 'object', additionalProperties: true, description: 'Candidate {nodes:[...]} definition.' },
      architectureVersion: { type: 'string', description: 'Alternative saved candidate definition digest.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(input, exec) {
      if (exec.agent === undefined) throw new Error('architecture_trial requires a calling agent')
      const plan = plans.get(input.planId)
      if (plan === undefined) throw new Error('unknown output trial plan')
      if ((input.architecture === undefined) === (input.architectureVersion === undefined)) throw new Error('provide exactly one candidate architecture or architectureVersion')
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      signal.throwIfAborted()
      const task = evaluate(plan, input, exec.agent, signal)
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    },
    presentCall: args => ({ card: 'generic', title: `architecture trial: ${args.planId}`, rawInput: JSON.stringify(args) }),
    presentResult: () => ({ card: 'generic' }),
  }))

  async function evaluate(
    plan: TrialPlan,
    input: { architecture?: unknown; architectureVersion?: string },
    parent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    await saveArchitecture(architectureDirectory, plan.baseline.architecture)
    const saved = input.architectureVersion === undefined
      ? await saveArchitecture(architectureDirectory, input.architecture)
      : await loadArchitecture(architectureDirectory, input.architectureVersion)
    const candidate = prepareOutputTrialArchitecture(saved.architecture)
    const candidateOutputs = new Set(candidate.architecture.nodes.map(node => node.id))
    for (const item of plan.cases) {
      if (!candidateOutputs.has(item.outputNode)) throw new Error('output trial node is missing from candidate')
    }
    signal.throwIfAborted()
    mkdirSync(receiptDirectory, { recursive: true })
    const trialId = randomUUID() as ArchitectureTrialId
    const file = openSync(join(receiptDirectory, `${trialId}.jsonl`), 'wx', 0o600)
    let storageError: Error | undefined
    const append = (data: Record<string, unknown>): void => {
      if (storageError !== undefined) throw storageError
      try {
        appendFileSync(file, JSON.stringify({ format: 1, trialId, ...data }) + '\n')
        fsyncSync(file)
      } catch (error: unknown) {
        storageError = new Error('output trial receipt could not be synchronized', { cause: error })
        throw storageError
      }
    }
    const results: CaseResult[] = []
    try {
      append({ type: 'trial-start', mode: 'output-only', planId: plan.id, planDigest: plan.digest,
        baselineVersion: plan.baseline.version, candidateVersion: candidate.version,
        parentSession: parent.id, executionLedger: ctx.executionLedger.file, maxCaseMs, maxTotalAgents, startedAt: Date.now() })
      for (const item of plan.cases) {
        for (const arm of ['baseline', 'candidate'] as const) {
          let result: CaseResult
          if (signal.aborted) result = { arm, caseId: item.id, status: 'unknown', reason: 'not-run' }
          else result = await runCase(arm === 'baseline' ? plan.baseline : candidate, item, arm, parent, signal, append)
          results.push(result)
          append({ type: 'case-end', ...result })
        }
      }
      const status = results.some(result => result.status === 'unknown') ? 'unknown'
        : results.some(result => result.arm === 'candidate' && result.status === 'fail') ? 'fail' : 'pass'
      const summary = { trialId, mode: 'output-only', planId: plan.id, planDigest: plan.digest,
        baselineVersion: plan.baseline.version, candidateVersion: candidate.version, status,
        baselinePassed: results.filter(result => result.arm === 'baseline' && result.status === 'pass').length,
        candidatePassed: results.filter(result => result.arm === 'candidate' && result.status === 'pass').length,
        casesPerArm: plan.cases.length, adopted: false, results }
      append({ type: 'trial-end', ...summary, endedAt: Date.now() })
      return json(summary)
    } finally { closeSync(file) }
  }

  async function runCase(
    architecture: ReturnType<typeof prepareOutputTrialArchitecture>,
    item: TrialCase,
    arm: CaseResult['arm'],
    parent: Agent,
    signal: AbortSignal,
    append: (data: Record<string, unknown>) => void,
  ): Promise<CaseResult> {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const timer = setTimeout(() => { controller.abort() }, maxCaseMs)
    let run: WorkflowRun | undefined
    let recordingError: Error | undefined
    const off = ctx.on('workflow/agent-start', (info, member) => {
      if (info.id !== run?.id) return
      try { append({ type: 'member-start', arm, caseId: item.id, runId: info.id, childId: member.childId, label: member.label }) }
      catch (error: unknown) { recordingError = new Error('output trial member recording failed', { cause: error }); controller.abort() }
    })
    const result: CaseResult = { arm, caseId: item.id, status: 'unknown', reason: 'execution-error' }
    let cleanupFailed = false
    try {
      append({ type: 'case-start', arm, caseId: item.id, architectureVersion: architecture.version, input: item.input,
        compiledDigest: createHash('sha256').update(architecture.script).digest('hex') })
      run = ctx.workflowEngine.start({ script: architecture.script, meta: { name: 'output-trial', description: 'Host-frozen paired output evaluation' },
        args: item.input, parent, signal: combined, maxTotalAgents })
      result.runId = run.id
      const settled = await run.result
      result.agentsStarted = settled.agentsStarted
      if (combined.aborted || settled.stopReason === 'cancelled') result.reason = 'cancelled'
      else if (settled.stopReason === 'completed') {
        const value = record(settled.value, ['architectureVersion', 'outputs'])
        if (value.architectureVersion !== architecture.version) throw new Error('output trial result definition mismatch')
        if (value.outputs !== null && typeof value.outputs === 'object' && !Array.isArray(value.outputs)
          && Object.hasOwn(value.outputs, item.outputNode)) {
          const actual = json((value.outputs as Record<string, unknown>)[item.outputNode])
          append({ type: 'case-output', arm, caseId: item.id, runId: run.id, outputNode: item.outputNode, actual })
          result.status = isDeepStrictEqual(actual, item.expected) ? 'pass' : 'fail'
          delete result.reason
        } else result.reason = 'missing-output'
      }
    } catch (error: unknown) {
      // Engine admission or malformed execution output is unknown, never a failed comparison.
      ctx.logger.warn(`architecture trial case could not complete: ${error instanceof Error ? error.name : 'unknown error'}`)
    } finally {
      try { await run?.dispose() }
      catch (error: unknown) {
        cleanupFailed = true
        ctx.logger.warn(`architecture trial cleanup failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      }
      clearTimeout(timer)
      off()
    }
    if (recordingError !== undefined) throw recordingError
    if (cleanupFailed) { result.status = 'unknown'; result.reason = 'cleanup-error' }
    else if (combined.aborted) { result.status = 'unknown'; result.reason = 'cancelled' }
    return result
  }
}
