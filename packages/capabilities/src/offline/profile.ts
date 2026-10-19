/**
 * The execution profile (ADR 0027): the learnable parts of layer 3 that a
 * running session uses.
 *
 * - In a real project: the version the user approved on the capability page
 *   (`<home>/offline-runs/applied.json`), for every project of the user;
 *   without one, the product's defaults (no guidance, the constant
 *   retrieval parameters).
 * - In a trial copy: the candidate the offline run put into the copy
 *   (`<copy>/.nexgent/offline-candidate.json`), else the defaults. A copy
 *   never reads the applied version, so a run scores exactly the candidate
 *   it hands over, and the starting version is scored the same way.
 *
 * The guidance is given once, at the first user turn of a root task, with
 * the handbook's message (never in the system prompt, so the prompt cache
 * holds); retrieval parameters set how many handbook entries a turn
 * retrieves, how strictly they must match, and how many learned skills are
 * drawn. A file that does not pass `offlineCandidateProblems` is ignored.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OFFLINE_APPLIED_FILE,
  OFFLINE_CANDIDATE_FILE,
  offlineCandidateProblems,
  resolveUserDataLayout,
  type HandbookTurnSelection,
  type OfflineAppliedProfile,
  type OfflineCandidate,
  type SessionRecord,
} from '@nexgent/kernel'

/** The opening line of the injected execution guidance. */
export const EXECUTION_GUIDANCE_HEADER = "How to work (general guidance; this task's own instructions always win):"

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** `<home>/offline-runs/applied.json`. */
export function appliedProfileFile(home: string): string {
  return join(resolveUserDataLayout(home).offlineRuns, OFFLINE_APPLIED_FILE)
}

/** The applied version, or `undefined` (none, unreadable or invalid). */
export async function readAppliedProfile(home: string): Promise<OfflineAppliedProfile | undefined> {
  const value = await readJson(appliedProfileFile(home))
  if (value === null || typeof value !== 'object') return undefined
  const profile = value as Partial<OfflineAppliedProfile>
  if (profile.formatVersion !== 1 || typeof profile.runId !== 'string' || typeof profile.versionId !== 'number' || typeof profile.appliedAt !== 'string') return undefined
  return offlineCandidateProblems(profile.candidate).length === 0 ? (profile as OfflineAppliedProfile) : undefined
}

async function writeAtomic(path: string, directory: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** Write the applied version (replacing any earlier one). @throws `TypeError` for an invalid candidate. */
export async function writeAppliedProfile(home: string, profile: OfflineAppliedProfile): Promise<OfflineAppliedProfile> {
  const problems = offlineCandidateProblems(profile.candidate)
  if (problems.length > 0) throw new TypeError(`invalid offline version: ${problems.join('; ')}`)
  await writeAtomic(appliedProfileFile(home), resolveUserDataLayout(home).offlineRuns, `${JSON.stringify(profile, null, 2)}\n`)
  return profile
}

/** Stop using the applied version: back to the product's defaults. */
export async function clearAppliedProfile(home: string): Promise<void> {
  await rm(appliedProfileFile(home), { force: true })
}

/** Put a candidate into a replay copy (its data directory). */
export async function writeCopyCandidate(dataDir: string, candidate: OfflineCandidate): Promise<void> {
  const problems = offlineCandidateProblems(candidate)
  if (problems.length > 0) throw new TypeError(`invalid offline version: ${problems.join('; ')}`)
  await writeAtomic(join(dataDir, OFFLINE_CANDIDATE_FILE), dataDir, `${JSON.stringify(candidate, null, 2)}\n`)
}

/**
 * The profile a project's sessions use now (see the module comment);
 * `undefined` means the defaults.
 */
export async function readExecutionProfile(input: { readonly home: string; readonly dataDir: string; readonly trialCopy: boolean }): Promise<OfflineCandidate | undefined> {
  if (input.trialCopy) {
    const value = await readJson(join(input.dataDir, OFFLINE_CANDIDATE_FILE))
    return value !== undefined && offlineCandidateProblems(value).length === 0 ? (value as OfflineCandidate) : undefined
  }
  return (await readAppliedProfile(input.home))?.candidate
}

/**
 * The guidance block for a root task's turn (pure): only for a root task
 * (no parent, no member, not an improvement session), only once per
 * session, and only when there is guidance.
 */
export function guidanceForTurn(records: readonly SessionRecord[], guidance: string | undefined): string | undefined {
  const text = guidance?.trim() ?? ''
  if (text === '') return undefined
  const start = records[0]
  if (start?.type !== 'session.start' || start.parentSessionId !== undefined || start.member !== undefined || start.purpose === 'improvement') return undefined
  if (records.some(record => record.type === 'user.message' && record.source === 'inject' && record.content.includes(EXECUTION_GUIDANCE_HEADER))) return undefined
  return `${EXECUTION_GUIDANCE_HEADER}\n${text}`
}

/** A turn's selection with the guidance before it (pure). */
export function withGuidance(selection: HandbookTurnSelection | undefined, guidance: string | undefined): HandbookTurnSelection | undefined {
  if (guidance === undefined) return selection
  if (selection === undefined) return { ids: [], text: guidance }
  return { ids: selection.ids, text: `${guidance}\n\n${selection.text}` }
}
