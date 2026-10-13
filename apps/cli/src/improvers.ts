/**
 * `nexgent improvers list | show | rollback`: the project's improver versions
 * (step 6) through the SDK's `improvers.*` methods, plus the meta-job
 * formatting `nexgent improve` shares (diagnosis, change, comparison).
 *
 * The formatting functions are pure so tests can pin the output.
 */
import { isNexgentError } from '@nexgent/kernel'
import type {
  ComparisonArmResult, ImproverChangeRecord, ImproverComparison, ImproverRevision, MetaDiagnosis,
} from '@nexgent/kernel'
import type { ImproverDetail, ImproverListing, ImproverVersionView } from '@nexgent/sdk'
import { CliError, EXIT } from './exit-codes.js'
import { formatTime, shortId } from './improve.js'

/** Characters of an improver version shown in text output (`v0` stays whole). */
export const SHORT_VERSION_CHARS = 12

/** `v0`, or the first {@link SHORT_VERSION_CHARS} characters of a sha256 version. */
export function shortVersion(version: string): string {
  return version.slice(0, SHORT_VERSION_CHARS)
}

/** `≈ $0.12` style cost for an arm. */
function usd(value: number | 'unknown'): string {
  if (value === 'unknown') return 'unknown'
  if (value > 0 && value < 0.005) return '≈ < $0.01'
  return `≈ $${value.toFixed(2)}`
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function armTokens(arm: ComparisonArmResult): string {
  const { usage } = arm.cost
  const parts = [usage.inputTokens, usage.outputTokens]
  if (parts.some(part => part === 'unknown')) return 'unknown tokens'
  return `${(parts as number[]).reduce((sum, part) => sum + part, 0)} tokens`
}

/** The change a meta job proposed (or a version came from), one op per line. */
export function formatChange(record: ImproverChangeRecord, indent = '  '): string[] {
  const { change } = record
  const lines = [`${indent}change: ${change.op}`]
  switch (change.op) {
    case 'set-diagnosis-paragraph':
      lines.push(`${indent}  paragraph ${change.index}: ${change.text}`)
      break
    case 'set-proposal-kinds':
      lines.push(`${indent}  kinds: ${change.kinds.join(', ')}`)
      break
    case 'set-proposal-brief':
      lines.push(`${indent}  kind: ${change.kind}`, `${indent}  template: ${firstLine(change.template)}`)
      break
    case 'set-comparison-param':
      lines.push(`${indent}  ${change.param} = ${change.value}`)
      break
  }
  lines.push(`${indent}  version: ${shortVersion(record.parentVersion)} -> ${shortVersion(record.childVersion)}`)
  lines.push(`${indent}  rationale: ${record.rationale}`)
  return lines
}

function firstLine(text: string): string {
  const [line = ''] = text.split('\n')
  return text.includes('\n') ? `${line} ...` : line
}

/** A meta job's diagnosis: hypothesis, proposal and findings. */
export function formatMetaDiagnosis(diagnosis: MetaDiagnosis, indent = '  '): string[] {
  const lines = [`${indent}meta diagnosis:`, `${indent}  hypothesis: ${diagnosis.hypothesis}`, `${indent}  proposal: ${diagnosis.proposal}`]
  for (const finding of diagnosis.findings) {
    lines.push(`${indent}  finding (${finding.stage}): ${finding.label} [jobs: ${finding.jobIds.map(shortId).join(', ') || 'none'}]`)
  }
  return lines
}

function formatArm(arm: ComparisonArmResult, indent: string): string[] {
  const lines = [`${indent}${arm.arm}: improver ${shortVersion(arm.improverVersion)}, status ${arm.status}${arm.candidateId === undefined ? '' : `, candidate ${arm.candidateId}`}`]
  if (arm.error !== undefined) lines.push(`${indent}  error: ${arm.error.code}: ${arm.error.message}`)
  if (arm.verdict !== undefined) {
    const { verdict } = arm
    lines.push(`${indent}  gate: ${verdict.outcome} (${verdict.reason}); pass rate candidate ${percent(verdict.passRate.candidate)} vs baseline ${percent(verdict.passRate.baseline)}`)
  }
  lines.push(`${indent}  cost: ${armTokens(arm)}, ${usd(arm.cost.estimatedUsd)}`)
  return lines
}

/** A meta job's parent / child comparison and verdict. */
export function formatComparison(comparison: ImproverComparison, indent = '  '): string[] {
  const lines = [`${indent}comparison: ${comparison.origin.kind} origin, job ${shortId(comparison.origin.sourceJobId)}`]
  lines.push(...formatArm(comparison.parent, `${indent}  `), ...formatArm(comparison.child, `${indent}  `))
  const { verdict } = comparison
  const extras = [
    ...(verdict.quality === undefined ? [] : [`quality parent ${percent(verdict.quality.parent)} child ${percent(verdict.quality.child)}`]),
    ...(verdict.costRatio === undefined ? [] : [`cost ratio ${verdict.costRatio.toFixed(2)}`]),
  ]
  lines.push(`${indent}  verdict: ${verdict.outcome} (${verdict.reason})${extras.length === 0 ? '' : `; ${extras.join('; ')}`}`)
  return lines
}

/** `#n adopt|rollback from -> to, trigger, time[, reason]`. */
export function formatRevision(revision: ImproverRevision): string {
  const job = revision.jobId === undefined ? '' : `, job ${shortId(revision.jobId)}`
  const reason = revision.reason === undefined ? '' : `: ${revision.reason}`
  return `#${revision.revision} ${revision.type} ${shortVersion(revision.from)} -> ${shortVersion(revision.version)}, ${revision.trigger}${job}, ${formatTime(revision.committedAt)}${reason}`
}

function formatCurrent(current: ImproverVersionView): string[] {
  const lines = [`  current: ${shortVersion(current.version)}`, `  revision: ${current.revision}`]
  if (current.since !== undefined) lines.push(`  since: ${formatTime(current.since)}`)
  if (current.trigger !== undefined) lines.push(`  trigger: ${current.trigger}`)
  if (current.jobId !== undefined) lines.push(`  job: ${shortId(current.jobId)}`)
  if (current.problem !== undefined) lines.push(`  problem: ${current.problem}`)
  return lines
}

/** The text of `nexgent improvers list`. */
export function formatImproverListing(listing: ImproverListing): string {
  const lines = ['Improver versions:', ...formatCurrent(listing.current)]
  if (listing.history.length === 0) {
    lines.push('  history: none (v0 has never changed)')
  } else {
    lines.push('  history:')
    for (const revision of listing.history) lines.push(`    ${formatRevision(revision)}`)
  }
  return lines.join('\n')
}

/** The text of `nexgent improvers show`. */
export function formatImproverDetail(detail: ImproverDetail): string {
  const { bundle } = detail
  const lines = [`Improver ${detail.version}`, `  current: ${detail.current ? 'yes' : 'no'}`]
  const paragraphs = bundle.diagnosis.paragraphs
  lines.push(`  diagnosis: ${count(paragraphs.length, 'paragraph')}`)
  for (const paragraph of paragraphs.slice(0, 3)) lines.push(`    - ${paragraph.length > 100 ? `${paragraph.slice(0, 100)}...` : paragraph}`)
  if (paragraphs.length > 3) lines.push(`    ... ${paragraphs.length - 3} more`)
  lines.push(`  proposal kinds: ${bundle.proposal.kinds.join(', ')}`)
  const { selectionCases, repeats, selection } = bundle.comparison
  lines.push(`  comparison: ${selectionCases} selection cases, ${count(repeats, 'repeat')}, selection ${selection}`)
  if (detail.change === undefined) lines.push('  change: none (the original improver)')
  else lines.push('  produced by:', ...formatChange(detail.change, '    '))
  return lines.join('\n')
}

/** One line for a rolled-back improver (`nexgent improvers rollback`). */
export function formatRolledBack(current: ImproverVersionView): string {
  return `improver rolled back: version ${shortVersion(current.version)} is now in force (revision ${current.revision}).`
}

/**
 * Resolve a full improver version (`v0` or sha256) or a unique prefix against the known versions.
 * @throws {@link CliError} - exit 3 for an unknown version, exit 2 for an ambiguous prefix.
 */
export function resolveImproverVersion(known: readonly string[], given: string): string {
  const versions = [...new Set(known)]
  if (versions.includes(given)) return given
  const matches = given === '' ? [] : versions.filter(version => version.startsWith(given))
  if (matches.length === 1 && matches[0] !== undefined) return matches[0]
  if (matches.length === 0) {
    throw new CliError(EXIT.ENVIRONMENT, `no improver version "${given}" (see \`nexgent improvers list\`)`, { code: 'improver/not-found' })
  }
  throw new CliError(
    EXIT.USAGE,
    `improver version prefix "${given}" is ambiguous: ${matches.map(shortVersion).join(', ')}; use more characters`,
    { code: 'improver/ambiguous' },
  )
}

/** The versions `improvers.list` knows: `v0`, the current one and every revision's ends. */
export function knownVersions(listing: ImproverListing): string[] {
  return ['v0', listing.current.version, ...listing.history.flatMap(revision => [revision.from, revision.version])]
}

/** Turn the SDK's refusals of `improvers.*` into readable CLI errors; other errors pass through. */
export function improverError(error: unknown): unknown {
  if (!isNexgentError(error)) return error
  if (error.code === 'improver/not-found') {
    return new CliError(EXIT.ENVIRONMENT, error.message, { code: error.code, cause: error })
  }
  return error
}
