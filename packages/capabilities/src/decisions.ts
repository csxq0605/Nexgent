/**
 * Decision records `.nexgent/capabilities/decisions/<id>.json`
 * (`data-formats.md` §候选与门控): written once with exclusive create, never
 * changed. A decision that names a `revision` takes effect only if that
 * activation revision names the decision back; a crash between the two
 * writes leaves a decision no revision points to, which readers ignore.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CAPABILITY_DIRS, CAPABILITY_LIMITS, NexgentError, type CapabilityDecision } from '@nexgent/kernel'
import { validateCapabilityFile } from '@nexgent/session'
import { publishExclusive } from './activation.js'

/** Directory name of decisions inside `.nexgent/capabilities/`. */
export const DECISIONS_DIR = CAPABILITY_DIRS.decisions

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A decision without the fields the writer fills (`formatVersion`, `id`, `decidedAt`). */
export type DecisionInput = Omit<CapabilityDecision, 'formatVersion' | 'id' | 'decidedAt'> & { readonly id?: string }

/**
 * Validate and publish a decision.
 * @param directory - `.nexgent/capabilities/decisions`.
 * @throws `config/invalid` for a decision the schema refuses; `internal` when the id is taken.
 */
export async function writeDecision(directory: string, input: DecisionInput, now: () => Date = () => new Date()): Promise<CapabilityDecision> {
  const detail = input.detail.length > CAPABILITY_LIMITS.maxReasonChars ? `${input.detail.slice(0, CAPABILITY_LIMITS.maxReasonChars - 1)}…` : input.detail
  const decision: CapabilityDecision = { ...input, formatVersion: 1, id: input.id ?? randomUUID(), decidedAt: now().toISOString(), detail }
  const issues = validateCapabilityFile('decision', decision)
  if (issues.length > 0) throw new NexgentError('config/invalid', `invalid capability decision: ${issues[0]!.path} ${issues[0]!.message}`)
  if (!(await publishExclusive(directory, `${decision.id}.json`, `${JSON.stringify(decision)}\n`))) {
    throw new NexgentError('internal', `capability decision ${decision.id} already exists`)
  }
  return decision
}

/**
 * Read one decision.
 * @throws `session/not-found` when absent, `session/corrupt` when it does not parse or validate.
 */
export async function readDecision(directory: string, id: string): Promise<CapabilityDecision> {
  if (!ID.test(id)) throw new NexgentError('session/not-found', `no capability decision ${JSON.stringify(id)}`)
  let raw: string
  try {
    raw = await readFile(join(directory, `${id}.json`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new NexgentError('session/not-found', `no capability decision ${id}`)
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new NexgentError('session/corrupt', `capability decision ${id} is not JSON`, { cause: error })
  }
  const issues = validateCapabilityFile('decision', value)
  if (issues.length > 0 || (value as CapabilityDecision).id !== id) throw new NexgentError('session/corrupt', `capability decision ${id} is invalid`)
  return value as CapabilityDecision
}

/** Every readable decision, oldest first; unreadable files are skipped. */
export async function listDecisions(directory: string): Promise<CapabilityDecision[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const decisions: CapabilityDecision[] = []
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!ID.test(id)) continue
    try {
      decisions.push(await readDecision(directory, id))
    } catch {
      // A damaged decision file is reported by whoever needs it (a revision naming it).
    }
  }
  return decisions.sort((left, right) => (left.decidedAt < right.decidedAt ? -1 : left.decidedAt > right.decidedAt ? 1 : 0))
}
