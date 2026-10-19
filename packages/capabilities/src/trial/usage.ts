/**
 * Usage-regression watch after a gate adoption (decision 6,
 * `decideUsageRollback`). The first `rollback.windowTasks` root tasks that
 * run on the newly adopted version are observed from the ledger: their
 * latest `task.outcome` gives the checks, and the `tool.call` records of the
 * candidate's new components (function-module and plugin tools, in call
 * order) give the error sequence; for components without tools (skills,
 * presets, …) the outcome's `componentsUsed` counts are used. Trial runs
 * (`trialId`) and member outcomes are not observed. When the rule fires, the
 * store writes a `rolled-back` decision (`trigger: usage-regression`, reason
 * `usage-regression` or `component-errors`, the evidence in `regression`)
 * and the rollback revision.
 *
 * Hosts run the check when a root session opens (before the version is
 * resolved) and after every root turn (passing that turn's own outcome,
 * which the SDK writes to the ledger only after the turn).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COMPONENT_ENTRY_FILES,
  componentDir,
  decideUsageRollback,
  functionToolName,
  type CapabilitiesConfig,
  type CapabilityComponentRef,
  type CapabilityDecision,
  type ComponentUsage,
  type Ledger,
  type LedgerRecord,
  type TaskCheck,
  type UsageObservation,
} from '@nexgent/kernel'
import { readCandidate } from '../candidates.js'
import type { CapabilityStore, CommittedChange } from '../capability-store.js'

/** A root task's result the ledger may not hold yet (the turn that just ended). */
export interface PendingOutcome {
  readonly taskId: string
  readonly capabilityVersion: string
  readonly checks?: readonly TaskCheck[]
  readonly componentsUsed?: readonly ComponentUsage[]
}

/** Options of {@link checkUsageRegression}. */
export interface UsageWatchOptions {
  readonly store: CapabilityStore
  readonly ledger: Pick<Ledger, 'read'>
  readonly rule: CapabilitiesConfig['rollback']
  readonly pending?: PendingOutcome
}

const TOOL_KINDS = new Set(['function-module', 'plugin'])

/** Tool names a component of a stored bundle adds (from its entry file). */
async function componentTools(bundleDir: string, component: CapabilityComponentRef): Promise<string[]> {
  if (!TOOL_KINDS.has(component.kind)) return []
  try {
    const entry = JSON.parse(await readFile(join(bundleDir, ...componentDir(component.kind, component.name).split('/'), COMPONENT_ENTRY_FILES[component.kind]), 'utf8')) as {
      functions?: { name?: unknown }[]
      tools?: unknown[]
    }
    if (component.kind === 'function-module') {
      return (entry.functions ?? []).flatMap(fn => (typeof fn.name === 'string' ? [functionToolName(component.name, fn.name)] : []))
    }
    return (entry.tools ?? []).filter((tool): tool is string => typeof tool === 'string')
  } catch {
    return []
  }
}

function isRoot(record: LedgerRecord): boolean {
  return record.memberId === undefined || record.memberId === 'main'
}

/**
 * Check the adopted version and roll back when its early use regressed.
 * @returns the rollback, or `undefined` when nothing fired (also when the
 *   tail is not a gate or approval adoption, or another writer moved it).
 */
export async function checkUsageRegression(options: UsageWatchOptions): Promise<CommittedChange | undefined> {
  const { store } = options
  const chain = await store.chain()
  if (chain.problem !== undefined) return undefined
  const tail = chain.revisions.at(-1)
  if (tail === undefined || tail.type !== 'adopt' || (tail.trigger !== 'gate' && tail.trigger !== 'approval')) return undefined
  let decision: CapabilityDecision
  try {
    decision = await store.decision(tail.decisionId)
  } catch {
    return undefined
  }
  if (decision.candidateId === undefined) return undefined
  let components: readonly CapabilityComponentRef[]
  try {
    components = (await readCandidate(store.directory, decision.candidateId)).components
  } catch {
    return undefined
  }
  // A plugin adopted on approval carries its gate verdict in the earlier awaiting-approval decision.
  const verdict = decision.verdict ?? (await store.decisions()).filter(item => item.candidateId === decision.candidateId && item.verdict !== undefined).at(-1)?.verdict
  const baselinePassRate = verdict?.passRate.baseline ?? 0

  const tools = new Map<string, CapabilityComponentRef>()
  for (const component of components) for (const tool of await componentTools(join(store.directory, tail.version), component)) tools.set(tool, component)
  const toolless = components.filter(component => !TOOL_KINDS.has(component.kind))

  const order: string[] = []
  const outcomes = new Map<string, { checks?: readonly TaskCheck[]; componentsUsed?: readonly ComponentUsage[] }>()
  const errors = new Map<string, boolean[]>()
  for await (const record of options.ledger.read({ from: tail.committedAt })) {
    if (record.trialId !== undefined || record.capabilityVersion !== tail.version || record.taskId === undefined) continue
    const taskId = record.taskId
    if (record.type === 'tool.call' && tools.has(record.name)) {
      const list = errors.get(taskId) ?? []
      list.push(record.isError)
      errors.set(taskId, list)
      if (!order.includes(taskId)) order.push(taskId)
    } else if (record.type === 'task.outcome' && isRoot(record)) {
      outcomes.set(taskId, { ...(record.checks === undefined ? {} : { checks: record.checks }), ...(record.componentsUsed === undefined ? {} : { componentsUsed: record.componentsUsed }) })
      if (!order.includes(taskId)) order.push(taskId)
    }
  }
  const pending = options.pending
  if (pending !== undefined && pending.capabilityVersion === tail.version) {
    outcomes.set(pending.taskId, { ...(pending.checks === undefined ? {} : { checks: pending.checks }), ...(pending.componentsUsed === undefined ? {} : { componentsUsed: pending.componentsUsed }) })
    if (!order.includes(pending.taskId)) order.push(pending.taskId)
  }

  const observations: UsageObservation[] = []
  for (const taskId of order) {
    const outcome = outcomes.get(taskId)
    const checks = outcome?.checks ?? []
    const componentErrors = [...(errors.get(taskId) ?? [])]
    for (const usage of outcome?.componentsUsed ?? []) {
      if (!toolless.some(component => component.kind === usage.kind && component.name === usage.name)) continue
      for (let index = 0; index < usage.calls - usage.errors; index += 1) componentErrors.push(false)
      for (let index = 0; index < usage.errors; index += 1) componentErrors.push(true)
    }
    observations.push({ taskId, checksPassed: checks.filter(check => check.passed).length, checksTotal: checks.length, componentErrors })
  }
  const fired = decideUsageRollback(observations, baselinePassRate, options.rule)
  if (fired === undefined) return undefined
  const detail = fired.reason === 'component-errors'
    ? `The new components failed ${fired.evidence.consecutiveErrors} calls in a row in the first tasks on this version; rolled back to the previous version.`
    : `The checks of the first ${fired.evidence.observations.length} tasks on this version passed ${Math.round(fired.evidence.passRate * 100)}%, below the ${Math.round(baselinePassRate * 100)}% the gate measured for the previous version; rolled back.`
  const observed = chain.activation
  return (await store.rollback({
    trigger: 'usage-regression',
    reason: fired.reason,
    candidateId: decision.candidateId,
    regression: fired.evidence,
    detail,
  }, observed).catch(() => null)) ?? undefined
}
