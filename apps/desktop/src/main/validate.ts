/**
 * Argument checks the IPC guard runs before any SDK call (guard step 4 of
 * `permissions.md` §本地 IPC 与访问令牌): the input is a plain JSON object,
 * required fields are present, every field has its type, path arguments are
 * absolute (or, for snapshot paths, relative without `..`), and no unknown
 * field rides along. Deeper semantic checks stay with the SDK.
 */
import { isAbsolute } from 'node:path'
import { SDK_METHOD_NAMES, type SdkMethodName } from '@nexgent/sdk'

type FieldKind =
  | 'string'
  | 'nonEmptyString'
  | 'absolutePath'
  | 'snapshotPath'
  | 'boolean'
  | 'version'
  | 'stringArray'
  | 'object'
  | 'sandboxMode'
  | 'goalStatus'
  | 'rating'
  | 'approvalDecision'
  | 'capabilityVersion'
  | 'handbookScope'
  | 'handbookStatus'
  | 'practiceSplit'

interface FieldSpec {
  readonly kind: FieldKind
  readonly optional?: boolean
}

type MethodSpec = Readonly<Record<string, FieldSpec>>

const id: FieldSpec = { kind: 'nonEmptyString' }
const project = { projectId: id } as const
const session = { projectId: id, sessionId: id } as const
const snapshot = { projectId: id, deliverableId: id, version: { kind: 'version' }, path: { kind: 'snapshotPath' } } as const

/** One entry per whitelisted method; a test keeps the keys equal to `SDK_METHOD_NAMES`. */
export const METHOD_SPECS: Readonly<Record<SdkMethodName, MethodSpec>> = {
  'app.info': {},
  'projects.recent': {},
  'projects.open': { root: { kind: 'absolutePath' }, create: { kind: 'boolean', optional: true } },
  'projects.close': project,
  'projects.forget': { root: { kind: 'absolutePath' } },
  'sessions.list': { projectId: id, includeChildren: { kind: 'boolean', optional: true } },
  'sessions.children': session,
  'sessions.view': session,
  'sessions.collaboration': session,
  'sessions.create': { projectId: id, title: { kind: 'string', optional: true }, sandboxMode: { kind: 'sandboxMode', optional: true }, plan: { kind: 'boolean', optional: true } },
  'sessions.coordinator': { projectId: id },
  'sessions.open': session,
  'sessions.close': session,
  'sessions.export': { ...session, outDir: { kind: 'absolutePath' } },
  'sessions.rename': { ...session, title: { kind: 'nonEmptyString' } },
  'sessions.setMode': { ...session, sandboxMode: { kind: 'sandboxMode', optional: true }, plan: { kind: 'boolean', optional: true } },
  'sessions.rewind': { ...session, turn: { kind: 'version' }, apply: { kind: 'boolean', optional: true } },
  'files.list': project,
  'dialogs.pickDirectory': {},
  'dialogs.pickFiles': {},
  'turns.send': { ...session, text: { kind: 'string' }, materialIds: { kind: 'stringArray', optional: true } },
  'turns.cancel': session,
  'approvals.respond': { ...session, decision: { kind: 'approvalDecision' } },
  'materials.add': { projectId: id, sourcePath: { kind: 'absolutePath' }, sessionId: { kind: 'nonEmptyString', optional: true } },
  'materials.list': { projectId: id, includeRemoved: { kind: 'boolean', optional: true } },
  'materials.remove': { projectId: id, materialId: id },
  'deliverables.list': project,
  'deliverables.get': { projectId: id, deliverableId: id, version: { kind: 'version' } },
  'deliverables.diff': { projectId: id, deliverableId: id, from: { kind: 'version' }, to: { kind: 'version' } },
  'deliverables.readText': snapshot,
  'deliverables.reveal': snapshot,
  'projects.revealData': project,
  'feedback.submit': {
    ...session,
    deliverableId: id,
    version: { kind: 'version' },
    rating: { kind: 'rating', optional: true },
    comment: { kind: 'string' },
  },
  'feedback.list': { projectId: id, sessionId: { kind: 'nonEmptyString', optional: true }, deliverableId: { kind: 'nonEmptyString', optional: true } },
  'goals.get': session,
  'goals.set': { ...session, text: { kind: 'nonEmptyString' } },
  'goals.update': { ...session, status: { kind: 'goalStatus' }, text: { kind: 'nonEmptyString', optional: true }, note: { kind: 'string', optional: true } },
  'settings.get': project,
  'settings.update': { projectId: id, patch: { kind: 'object' } },
  'settings.setApiKey': { value: { kind: 'string' } },
  'userSettings.get': {},
  'userSettings.update': { patch: { kind: 'object' } },
  'capabilities.current': project,
  'capabilities.list': project,
  'capabilities.show': { projectId: id, candidateId: id },
  'capabilities.trial': { projectId: id, candidateId: id },
  'capabilities.rollback': { projectId: id, toVersion: { kind: 'capabilityVersion', optional: true }, reason: { kind: 'string', optional: true } },
  'handbook.list': { projectId: id, scope: { kind: 'handbookScope', optional: true }, includeRetired: { kind: 'boolean', optional: true } },
  'handbook.show': { projectId: id, entryId: id },
  'handbook.setStatus': { projectId: id, entryId: id, status: { kind: 'handbookStatus' }, reason: { kind: 'string', optional: true } },
  'learning.status': project,
  'learning.acknowledge': {},
  'practice.list': { projectId: { kind: 'nonEmptyString', optional: true }, split: { kind: 'practiceSplit', optional: true } },
  'practice.show': { caseId: id },
}

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'full-access'])
const GOAL_STATUSES = new Set(['active', 'completed', 'abandoned'])
const DECISION_KEYS = new Set(['id', 'decision', 'scope', 'reason'])

/** Whether `value` is a plain object (what structured clone yields for a JSON object). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether a snapshot-relative path stays inside its snapshot: relative, no `..` segment, no drive or UNC prefix. */
export function isSnapshotPath(value: string): boolean {
  if (value === '' || value.includes('\0')) return false
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) return false
  return value.split(/[\\/]/).every((segment) => segment !== '..')
}

function checkField(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string'
    case 'nonEmptyString':
      return typeof value === 'string' && value.length > 0
    case 'absolutePath':
      // Both platforms' absolute forms are accepted only on their own platform (`path.isAbsolute`).
      return typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value)
    case 'snapshotPath':
      return typeof value === 'string' && isSnapshotPath(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    case 'stringArray':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
    case 'object':
      return isPlainObject(value)
    case 'sandboxMode':
      return typeof value === 'string' && SANDBOX_MODES.has(value)
    case 'goalStatus':
      return typeof value === 'string' && GOAL_STATUSES.has(value)
    case 'rating':
      return typeof value === 'number' && Number.isFinite(value)
    case 'capabilityVersion':
      return typeof value === 'string' && /^(?:baseline|[a-f0-9]{64})$/.test(value)
    case 'handbookScope':
      return value === 'user' || value === 'project'
    case 'handbookStatus':
      return value === 'active' || value === 'retired'
    case 'practiceSplit':
      return value === 'train' || value === 'selection' || value === 'holdout' || value === 'guard'
    case 'approvalDecision':
      // `decidedBy` is set by the main process side, never by the page.
      return (
        isPlainObject(value) &&
        Object.keys(value).every((key) => DECISION_KEYS.has(key)) &&
        typeof value['id'] === 'string' &&
        (value['decision'] === 'allow' || value['decision'] === 'deny') &&
        typeof value['scope'] === 'string' &&
        (value['reason'] === undefined || typeof value['reason'] === 'string')
      )
  }
}

/** Whether `method` is on the whitelist. */
export function isWhitelisted(method: unknown): method is SdkMethodName {
  return typeof method === 'string' && (SDK_METHOD_NAMES as readonly string[]).includes(method)
}

/**
 * Check one call's input against its method's spec.
 * @returns `undefined` when valid, otherwise a short reason naming the field (never its value).
 */
export function validateInput(method: SdkMethodName, input: unknown): string | undefined {
  if (!isPlainObject(input)) return 'input is not a plain object'
  const spec = METHOD_SPECS[method]
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(spec, key)) return `unknown field ${JSON.stringify(key.slice(0, 64))}`
  }
  for (const [key, field] of Object.entries(spec)) {
    const value = input[key]
    if (value === undefined) {
      if (field.optional === true) continue
      return `missing field ${key}`
    }
    if (!checkField(field.kind, value)) return `invalid field ${key}`
  }
  return undefined
}
