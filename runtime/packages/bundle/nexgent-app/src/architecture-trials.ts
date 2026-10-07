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
import type { WorkflowAgentInfo, WorkflowRun } from '@deepseek-ai/dsh-workflow'
import type {} from './execution-ledger.ts'
import { commitActivation, finishSelection, readActivation, reserveSelection } from './architecture-activation.ts'

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
  /** Host policies: {id,description,selectionPlanId,guardPlanId,maxCandidates}; default none. */
  policies?: unknown[]
  /** Absolute private activation directory, required when policies exist. */
  activationDirectory?: string
  /** Per-case execution deadline in milliseconds (default 180000). */
  maxCaseMs?: number
  /** Total member cap for each case (default 32, bounded by the workflow engine). */
  maxTotalAgents?: number
}

export const Config: z<Config> = z.object({
  architectureDirectory: z.string(),
  receiptDirectory: z.string(),
  plans: z.array(z.any()).default([]),
  policies: z.array(z.any()).default([]),
  activationDirectory: z.string().default(''),
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
interface SelectionPolicy {
  id: string
  description: string
  selection: TrialPlan
  guard: TrialPlan
  maxCandidates: number
  digest: string
  outputNode: string
}
interface TrialSummary {
  trialId: ArchitectureTrialId
  mode: 'output-only'
  planId: string
  planDigest: string
  baselineVersion: string
  candidateVersion: string
  status: 'pass' | 'fail' | 'unknown'
  baselinePassed: number
  candidatePassed: number
  casesPerArm: number
  adopted: false
  results: CaseResult[]
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

function readPolicies(values: unknown[], plans: Map<string, TrialPlan>, maxCaseMs: number,
  maxTotalAgents: number): Map<string, SelectionPolicy> {
  const policies = new Map<string, SelectionPolicy>()
  for (const value of values) {
    const row = record(value, ['id', 'description', 'selectionPlanId', 'guardPlanId', 'maxCandidates'])
    const id = text(row.id)
    const description = text(row.description)
    const selection = plans.get(text(row.selectionPlanId))
    const guard = plans.get(text(row.guardPlanId))
    if (policies.has(id) || selection === undefined || guard === undefined || selection === guard
      || selection.baseline.version !== guard.baseline.version) throw new Error('selection policies require unique ids and two plans with the same baseline')
    if (!Number.isSafeInteger(row.maxCandidates) || typeof row.maxCandidates !== 'number' || row.maxCandidates < 1) throw new Error('selection policy requires a positive candidate budget')
    const allCases = [...selection.cases, ...guard.cases]
    let outputNode = ''
    for (const item of allCases) outputNode = item.outputNode
    if (allCases.some(item => item.outputNode !== outputNode)
      || selection.cases.some(item => guard.cases.some(other => isDeepStrictEqual(item.input, other.input)))) {
      throw new Error('selection and guard require one output node and disjoint frozen inputs')
    }
    const maxCandidates = row.maxCandidates
    const digest = createHash('sha256').update(JSON.stringify({ format: 1, id, description,
      selection: selection.digest, guard: guard.digest, maxCandidates, mode: 'output-only', maxCaseMs, maxTotalAgents,
      compiledBaseline: createHash('sha256').update(selection.baseline.script).digest('hex') })).digest('hex')
    policies.set(id, { id, description, selection, guard, maxCandidates, digest, outputNode })
  }
  return policies
}

/**
 * Install a paired-trial consumer with criteria detached at composition time.
 * Empty plans expose no model tool. Every started native run is drained before
 * its receipt reports a case outcome; unloading cancels and drains active calls.
 * @param ctx - application-owned native tool and workflow context.
 * @param config - validated host configuration and frozen JSON criteria.
 */
export function apply(ctx: Context, config: Config): void {
  const { architectureDirectory, receiptDirectory, plans: values, policies: policyValues,
    activationDirectory, maxCaseMs, maxTotalAgents } = config as Required<Config>
  if (!isAbsolute(architectureDirectory) || !isAbsolute(receiptDirectory)) throw new Error('output trial directories must be absolute')
  const plans = readPlans(values)
  const policies = readPolicies(policyValues, plans, maxCaseMs, maxTotalAgents)
  if (policies.size > 0 && !isAbsolute(activationDirectory)) throw new Error('selection policies require an absolute activationDirectory')
  if (plans.size === 0) return
  const reservedPlans = new Set([...policies.values()].flatMap(policy => [policy.selection.id, policy.guard.id]))
  const exploratoryPlans = [...plans.values()].filter(plan => !reservedPlans.has(plan.id))
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  function own<T>(task: Promise<T>): Promise<T> {
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  })
  if (exploratoryPlans.length > 0) {
    ctx.systemPrompt.section({
      name: 'tool:architecture_trial',
      order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: 'Use architecture_trial to compare an output-only candidate with a host-frozen baseline. A pass is case evidence, not adoption or an improvement claim.',
    })
    ctx.tools.register(defineTool({
      name: 'architecture_trial',
      description: `Compare a candidate graph with a frozen baseline on the host's input cases. Supply exactly one of architecture or architectureVersion, plus planId. Every member's global tools are disabled; scoped structured output remains. The host compares actual node outputs with frozen JSON values. Execution, cancellation and cleanup failures remain unknown. No case answers can be supplied or changed here. Plans: ${JSON.stringify(exploratoryPlans.map(plan => ({ id: plan.id, description: plan.description })))}. Results do not adopt a version, measure paid cost or establish general improvement.`,
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
        if (plan === undefined || reservedPlans.has(plan.id)) throw new Error('unknown output trial plan')
        if ((input.architecture === undefined) === (input.architectureVersion === undefined)) throw new Error('provide exactly one candidate architecture or architectureVersion')
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        return own(evaluate(plan, input, exec.agent, signal).then(json))
      },
      presentCall: args => ({ card: 'generic', title: `architecture trial: ${args.planId}`, rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
  }

  if (policies.size > 0) {
    const descriptions = JSON.stringify([...policies.values()].map(policy => ({ id: policy.id, description: policy.description })))
    ctx.systemPrompt.section({ name: 'tool:architecture_policy', order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: 'For a configured output task, architecture_run automatically resolves its current accepted version. architecture_adopt evaluates a candidate once on independent host-frozen selection and guard cases. Adoption requires strict selection improvement and a passing guard. Global tools remain disabled in adopted execution.' })
    ctx.tools.register(defineTool({
      name: 'architecture_adopt',
      description: `Evaluate an output-only candidate once for a configured task policy. Supply exactly one architecture or architectureVersion. The host adopts only a candidate that passes all selection cases, strictly improves the frozen baseline's pass count, and then passes independent guard cases. Ties, failures and unknown results never adopt. Selection attempts, including interruptions, consume the host's candidate budget and cannot replay. Policies: ${descriptions}.`,
      parameters: { policyId: { type: 'string', required: true },
        architecture: { type: 'object', additionalProperties: true }, architectureVersion: { type: 'string' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(input, exec) {
        if (exec.agent === undefined) throw new Error('architecture_adopt requires a calling agent')
        const policy = policies.get(input.policyId)
        if (policy === undefined) throw new Error('unknown architecture policy')
        if ((input.architecture === undefined) === (input.architectureVersion === undefined)) throw new Error('provide exactly one candidate architecture or architectureVersion')
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        return own(adopt(policy, input, exec.agent, signal))
      },
      presentCall: args => ({ card: 'generic', title: `architecture adoption: ${args.policyId}`, rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
    ctx.tools.register(defineTool({
      name: 'architecture_run',
      description: `Run a configured output task using its current accepted architecture, or its frozen baseline before adoption or after rollback. The host resolves the version automatically; no version id is needed. Every member's global tools remain disabled. Failed or missing structured execution rolls the observed accepted revision back to baseline for later tasks. A completed output has no automatic quality score. Policies: ${descriptions}.`,
      parameters: { policyId: { type: 'string', required: true }, input: { type: 'object', additionalProperties: true, required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(input, exec) {
        if (exec.agent === undefined) throw new Error('architecture_run requires a calling agent')
        const policy = policies.get(input.policyId)
        if (policy === undefined) throw new Error('unknown architecture policy')
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        signal.throwIfAborted()
        return own(executeAccepted(policy, input.input, exec.agent, signal))
      },
      presentCall: args => ({ card: 'generic', title: `architecture run: ${args.policyId}`, rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
  }

  async function adopt(policy: SelectionPolicy, input: { architecture?: unknown; architectureVersion?: string },
    parent: Agent, signal: AbortSignal): Promise<JsonValue> {
    const candidate = input.architectureVersion === undefined ? await saveArchitecture(architectureDirectory, input.architecture)
      : await loadArchitecture(architectureDirectory, input.architectureVersion)
    signal.throwIfAborted()
    const directory = join(activationDirectory, policy.digest)
    const baseline = policy.selection.baseline.version
    const observed = readActivation(directory, baseline)
    if (observed.version === baseline) {
      const attempts = reserveSelection(directory, candidate.version, policy.maxCandidates)
      const selection = await evaluate(policy.selection, { architectureVersion: candidate.version }, parent, signal)
      const qualified = selection.status === 'pass' && selection.candidatePassed > selection.baselinePassed
      const guard = qualified && !signal.aborted
        ? await evaluate(policy.guard, { architectureVersion: candidate.version }, parent, signal) : undefined
      const approved = guard?.status === 'pass' && !signal.aborted
      const activation = approved ? commitActivation(directory, baseline, observed, candidate.version, 'adopt',
        { policyId: policy.id, policyDigest: policy.digest, mode: 'output-only', selectionTrial: selection.trialId, guardTrial: guard.trialId },
        createHash('sha256').update(prepareOutputTrialArchitecture(candidate.architecture).script).digest('hex')) : null
      const decision = { format: 1, policyId: policy.id, policyDigest: policy.digest, candidateVersion: candidate.version,
        selection, guard: guard ?? null, adopted: activation !== null, activation,
        reason: signal.aborted ? 'cancelled' : !qualified ? 'selection-not-improved' : !approved ? 'guard-not-passed'
          : activation === null ? 'activation-conflict' : 'accepted' }
      finishSelection(attempts, candidate.version, decision)
      return json(decision)
    } else {
      throw new Error('architecture already accepted; freeze a new policy for further evolution')
    }
  }

  async function executeAccepted(policy: SelectionPolicy, input: unknown, parent: Agent, signal: AbortSignal): Promise<JsonValue> {
    await saveArchitecture(architectureDirectory, policy.selection.baseline.architecture)
    const baseline = policy.selection.baseline.version
    const directory = join(activationDirectory, policy.digest)
    const observed = readActivation(directory, baseline)
    const saved = await loadArchitecture(architectureDirectory, observed.version)
    const architecture = prepareOutputTrialArchitecture(saved.architecture)
    const compiledDigest = createHash('sha256').update(architecture.script).digest('hex')
    if (observed.compiledDigest !== null && observed.compiledDigest !== compiledDigest) {
      throw new Error('accepted architecture compilation changed; a new frozen evaluation is required')
    }
    signal.throwIfAborted()
    const deadline = new AbortController()
    const combined = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, maxCaseMs)
    let run: WorkflowRun | undefined
    const members: Array<Pick<WorkflowAgentInfo, 'childId' | 'label'>> = []
    const off = ctx.on('workflow/agent-start', (info, member) => {
      if (info.id === run?.id) members.push({ childId: member.childId, label: member.label })
    })
    let output: JsonValue | undefined
    let cleanupFailed = false
    try {
      run = ctx.workflowEngine.start({ script: architecture.script, meta: { name: 'accepted-output-task', description: policy.description },
        args: json(input), parent, signal: combined, maxTotalAgents })
      const result = await run.result
      if (result.stopReason === 'completed' && !combined.aborted) {
        const value = record(result.value, ['architectureVersion', 'outputs'])
        if (value.architectureVersion !== observed.version) throw new Error('accepted architecture result definition mismatch')
        if (value.outputs !== null && typeof value.outputs === 'object' && !Array.isArray(value.outputs) && Object.hasOwn(value.outputs, policy.outputNode)) {
          output = json((value.outputs as Record<string, unknown>)[policy.outputNode])
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`accepted architecture could not complete: ${error instanceof Error ? error.name : 'unknown error'}`)
    } finally {
      try { await run?.dispose() }
      catch (error: unknown) {
        cleanupFailed = true
        ctx.logger.warn(`accepted architecture cleanup failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      }
      clearTimeout(timer)
      off()
    }
    const completed = output !== undefined && !cleanupFailed && !combined.aborted
    // User cancellation supplies no regression evidence. A native deadline does.
    const rollback = !completed && !signal.aborted && observed.version !== baseline
      ? commitActivation(directory, baseline, observed, baseline, 'rollback', { policyId: policy.id, mode: 'output-only',
        parentSession: parent.id, runId: run?.id ?? null, reason: 'execution-unknown' },
      createHash('sha256').update(policy.selection.baseline.script).digest('hex')) : null
    return json({ policyId: policy.id, policyDigest: policy.digest, mode: 'output-only', architectureVersion: observed.version,
      activationRevision: observed.revision, compiledDigest,
      parentSession: parent.id, executionLedger: ctx.executionLedger.file, runId: run?.id ?? null,
      members, status: completed ? 'completed' : 'unknown', output: completed ? output : null,
      rolledBack: rollback !== null, rollback })
  }

  async function evaluate(
    plan: TrialPlan,
    input: { architecture?: unknown; architectureVersion?: string },
    parent: Agent,
    signal: AbortSignal,
  ): Promise<TrialSummary> {
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
      const summary: TrialSummary = { trialId, mode: 'output-only', planId: plan.id, planDigest: plan.digest,
        baselineVersion: plan.baseline.version, candidateVersion: candidate.version, status,
        baselinePassed: results.filter(result => result.arm === 'baseline' && result.status === 'pass').length,
        candidatePassed: results.filter(result => result.arm === 'candidate' && result.status === 'pass').length,
        casesPerArm: plan.cases.length, adopted: false, results }
      append({ type: 'trial-end', ...summary, endedAt: Date.now() })
      return summary
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
