/**
 * `nexgent improve list | show | run | cancel`: improvement jobs (step 5)
 * through the SDK's `improvements.*` methods, plus the one-line note that
 * `run` / `resume` print when a job started or changed during the run.
 *
 * The formatting functions are pure so tests can pin the output.
 */
import { isNexgentError } from '@nexgent/kernel'
import type { ImprovementDetail, ImprovementJobView, ImprovementListing } from '@nexgent/sdk'
import { CliError, EXIT } from './exit-codes.js'

/** Characters of a job id shown in lists. */
export const SHORT_ID_CHARS = 8

/** First {@link SHORT_ID_CHARS} characters of a job id. */
export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_CHARS)
}

/** `2026-10-13 09:12Z` from an ISO-8601 UTC time (anything unparsable is kept as is). */
export function formatTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : iso
}

/** Billed tokens of a job: the sum over phases, `unknown` when any phase is unknown. */
export function billedTokensOf(view: Pick<ImprovementJobView, 'tokens'>): number | 'unknown' {
  let total = 0
  for (const value of Object.values(view.tokens)) {
    if (value === 'unknown') return 'unknown'
    if (typeof value === 'number') total += value
  }
  return total
}

function formatTokens(value: number | 'unknown'): string {
  return value === 'unknown' ? 'unknown' : `${value} tokens`
}

/** `≈ $0.12`, `≈ < $0.01`, or `unknown`. */
export function formatCost(usd: number | 'unknown'): string {
  if (usd === 'unknown') return 'unknown'
  if (usd > 0 && usd < 0.005) return '≈ < $0.01'
  return `≈ $${usd.toFixed(2)}`
}

/** The text of `nexgent improve list`. */
export function formatListing(listing: ImprovementListing): string {
  const { pending, threshold, budget } = listing
  const header = [
    `pending ${pending}/${threshold}`,
    ...(listing.activeJobId === undefined ? [] : [`active ${shortId(listing.activeJobId)}`]),
    `budget ${budget.usedTokens}/${budget.maxTokens} tokens in ${budget.windowDays} days`,
  ].join(' | ')
  const lines = [`Improvement jobs: ${header}`]
  if (listing.jobs.length === 0) {
    lines.push('No improvement jobs yet.')
    return lines.join('\n')
  }
  for (const job of listing.jobs) {
    lines.push(
      `${shortId(job.id)}  ${job.status}  ${job.trigger}  ${formatTime(job.createdAt)}  ${formatTokens(billedTokensOf(job))}  ${formatCost(job.estimatedUsd)}`,
    )
    if (job.detail !== undefined) lines.push(`    ${job.detail}`)
  }
  return lines.join('\n')
}

/** The text of `nexgent improve show`. */
export function formatDetail(detail: ImprovementDetail): string {
  const { view, job, diagnosis, candidate } = detail
  const lines = [`Improvement job ${job.id}`, `  status: ${job.status}`]
  lines.push(`  trigger: ${job.trigger}, ${job.items.length} item${job.items.length === 1 ? '' : 's'}`)
  lines.push('  history:')
  for (const change of job.history) {
    lines.push(`    ${formatTime(change.at)}  ${change.status}${change.detail === undefined ? '' : `: ${change.detail}`}`)
  }
  if (diagnosis !== undefined) {
    lines.push('  diagnosis:')
    lines.push(`    hypothesis: ${diagnosis.hypothesis}`)
    lines.push(`    proposal kind: ${diagnosis.proposalKind}`)
    for (const failure of diagnosis.failureTypes) {
      const n = failure.evidence.length
      lines.push(`    failure (${failure.category}): ${failure.label} [${n} evidence record${n === 1 ? '' : 's'}]`)
    }
  }
  if (candidate !== undefined) {
    const { view: cand } = candidate
    lines.push('  candidate:')
    lines.push(`    id: ${cand.id}, status: ${cand.status}`)
    lines.push(`    components: ${cand.components.map(ref => `${ref.kind}/${ref.name}`).join(', ') || '(none)'}`)
    if (cand.decision !== undefined) {
      lines.push(`    decision: ${cand.decision.outcome} (${cand.decision.reason})${cand.decision.detail === '' ? '' : `: ${cand.decision.detail}`}`)
    }
    const end = [...candidate.receipts].reverse().find(receipt => receipt.type === 'trial.end')
    if (end?.type === 'trial.end') {
      const { verdict } = end
      const pass = `candidate ${percent(verdict.passRate.candidate)} vs baseline ${percent(verdict.passRate.baseline)}`
      lines.push(`    gate: ${verdict.outcome} (${verdict.reason}); pass rate ${pass}; trial ${end.status}`)
    }
  }
  const phases = Object.entries(view.tokens)
  lines.push(`  tokens: ${phases.length === 0 ? 'none yet' : phases.map(([phase, value]) => `${phase} ${value}`).join(', ')}`)
  lines.push(`  estimated cost: ${formatCost(view.estimatedUsd)}`)
  if (job.firstUse !== undefined) {
    lines.push(`  first use: ${formatTime(job.firstUse.at)} in session ${job.firstUse.sessionId} (task ${job.firstUse.taskId}, version ${job.firstUse.version})`)
  }
  if (job.rolledBack !== undefined) lines.push(`  rolled back: ${formatTime(job.rolledBack.at)} (decision ${job.rolledBack.decisionId})`)
  return lines.join('\n')
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/** One line for a started job (`nexgent improve run`). */
export function formatStarted(job: ImprovementJobView): string {
  return `improvement job ${job.id} started (${job.status}); it runs in the background. Follow it with \`nexgent improve list\` or \`nexgent improve show ${shortId(job.id)}\`.`
}

/** One line for a cancelled job. */
export function formatCancelled(job: ImprovementJobView): string {
  return `improvement job ${job.id} is now ${job.status}.`
}

/**
 * The note `run` / `resume` print at the end when improvement jobs started or
 * changed status during the run; `undefined` when there is nothing to say.
 */
export function formatRunNote(jobs: readonly ImprovementJobView[]): string | undefined {
  const [first, ...rest] = jobs
  if (first === undefined) return undefined
  const more = rest.length === 0 ? '' : ` (and ${rest.length} more)`
  return `nexgent: background improvement job ${shortId(first.id)} ${first.status}${more}; follow it with \`nexgent improve list\` or \`nexgent improve show ${shortId(first.id)}\`.`
}

/**
 * Resolve a full job id or a unique prefix against the listed jobs.
 * @throws {@link CliError} - exit 3 for an unknown id, exit 2 for an ambiguous prefix.
 */
export function resolveJobId(jobs: readonly Pick<ImprovementJobView, 'id'>[], given: string): string {
  const exact = jobs.find(job => job.id === given)
  if (exact !== undefined) return exact.id
  const matches = jobs.filter(job => job.id.startsWith(given))
  if (matches.length === 1 && matches[0] !== undefined) return matches[0].id
  if (matches.length === 0) {
    throw new CliError(EXIT.ENVIRONMENT, `no improvement job "${given}" (see \`nexgent improve list\`)`, { code: 'improvement/not-found' })
  }
  throw new CliError(
    EXIT.USAGE,
    `improvement job prefix "${given}" is ambiguous: ${matches.map(job => shortId(job.id)).join(', ')}; use more characters`,
    { code: 'improvement/ambiguous' },
  )
}

/** Turn the SDK's refusals of `improvements.*` into readable CLI errors; other errors pass through. */
export function improveError(error: unknown): unknown {
  if (!isNexgentError(error)) return error
  if (error.code === 'improvement/busy') {
    const jobId = (error.details as { jobId?: unknown } | undefined)?.jobId
    const which = typeof jobId === 'string' ? ` (${shortId(jobId)})` : ''
    return new CliError(EXIT.TASK_FAILED, `an improvement job is already running${which}; one job runs at a time. Wait for it, or stop it with \`nexgent improve cancel${typeof jobId === 'string' ? ` ${shortId(jobId)}` : ' <jobId>'}\`.`, { code: error.code, cause: error })
  }
  if (error.code === 'improvement/budget-exhausted') {
    return new CliError(EXIT.TASK_FAILED, `the improvement budget is spent: ${error.message}. Raise the budget in the project settings or wait for the window to pass.`, { code: error.code, cause: error })
  }
  if (error.code === 'improvement/not-found') {
    return new CliError(EXIT.ENVIRONMENT, error.message, { code: error.code, cause: error })
  }
  return error
}
