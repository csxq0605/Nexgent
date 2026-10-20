/**
 * Team state as the Lead's session records it (legacy records, `data-formats.md` §旧格式（只为读旧项目）): the
 * roster (`team.member`, latest per name), the task board (`team.task`,
 * latest per id) and the mailbox (`team.message`, queued then delivered under
 * the same id). Everything here is pure: {@link reduceTeam} rebuilds the
 * state from records, the `check*` functions validate a change before it is
 * recorded, and {@link applyRecord} folds a written record in.
 */
import {
  COLLABORATION_LIMITS,
  MEMBER_NAME_PATTERN,
  NexgentError,
  TEAM_LEAD_NAME,
  type SessionRecord,
  type TeamMember,
  type TeamMessage,
  type TeamTask,
  type TeamTaskStatus,
} from '@nexgent/kernel'

/** Roster entries a team may hold (stopped ones count). */
export const MAX_TEAM_MEMBERS = COLLABORATION_LIMITS.maxMembersPerTask

/** The state of one Lead session's team. */
export interface TeamState {
  /** Roster by name, in first-spawn order. */
  readonly members: Map<string, TeamMember>
  /** Task board by id, in creation order. */
  readonly tasks: Map<string, TeamTask>
  /** Mailbox by message id, in send order; the latest state wins. */
  readonly messages: Map<string, TeamMessage>
}

/** An empty team. */
export function emptyTeam(): TeamState {
  return { members: new Map(), tasks: new Map(), messages: new Map() }
}

/** Fold one record into `state` (other record types are ignored). */
export function applyRecord(state: TeamState, record: SessionRecord): void {
  switch (record.type) {
    case 'team.member':
      state.members.set(record.member.name, record.member)
      break
    case 'team.task':
      state.tasks.set(record.task.id, record.task)
      break
    case 'team.message': {
      const known = state.messages.get(record.message.id)
      // `delivered` is final: a late duplicate `queued` never reopens a message.
      if (known?.state !== 'delivered') state.messages.set(record.message.id, record.message)
      break
    }
    default:
      break
  }
}

/** Rebuild a team from the Lead's records. Pure. */
export function reduceTeam(records: readonly SessionRecord[]): TeamState {
  const state = emptyTeam()
  for (const record of records) applyRecord(state, record)
  return state
}

/** Whether the records hold any team state. */
export function hasTeam(state: TeamState): boolean {
  return state.members.size > 0 || state.tasks.size > 0 || state.messages.size > 0
}

/** Messages to `name` that are queued and not delivered, in send order. */
export function pendingFor(state: TeamState, name: string): TeamMessage[] {
  return [...state.messages.values()].filter(message => message.to === name && message.state === 'queued')
}

/** The id the board gives its next task (`t1`, `t2`, …). */
export function nextTaskId(state: TeamState): string {
  let max = 0
  for (const id of state.tasks.keys()) {
    const n = /^t(\d+)$/.exec(id)
    if (n !== null) max = Math.max(max, Number(n[1]))
  }
  return `t${max + 1}`
}

function invalid(message: string, details?: Record<string, unknown>): NexgentError {
  return new NexgentError('tool/invalid-input', message, details === undefined ? {} : { details })
}

/** Whether `name` can be addressed: `lead`, or a roster member that is not stopped. */
export function isAddressable(state: TeamState, name: string): boolean {
  if (name === TEAM_LEAD_NAME) return true
  const member = state.members.get(name)
  return member !== undefined && member.status !== 'stopped'
}

function roster(state: TeamState): string {
  const names = [...state.members.values()].filter(member => member.status !== 'stopped').map(member => member.name)
  return [TEAM_LEAD_NAME, ...names].join(', ')
}

/**
 * Check a new teammate's name.
 * @throws `tool/invalid-input` for a bad or taken name, `tool/denied` when the roster is full.
 */
export function checkSpawn(state: TeamState, name: string): void {
  if (!MEMBER_NAME_PATTERN.test(name)) {
    throw invalid(`"name" must match ${String(MEMBER_NAME_PATTERN)} (lowercase letters, digits and dashes, starting with a letter)`)
  }
  if (name === TEAM_LEAD_NAME) throw invalid('"lead" is the main conversation\'s name in the team; pick another name')
  const existing = state.members.get(name)
  if (existing !== undefined && existing.status !== 'stopped') {
    throw invalid(`a teammate named "${name}" is already on the team (${existing.status}); send it a message instead`)
  }
  if (existing === undefined && state.members.size >= MAX_TEAM_MEMBERS) {
    throw new NexgentError('tool/denied', `a team holds at most ${MAX_TEAM_MEMBERS} teammates`)
  }
}

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Check a message before it is queued.
 * @throws `tool/invalid-input` for an unknown recipient, a message to oneself, an empty or oversized body,
 *   `tool/denied` when the recipient already has the maximum of undelivered messages.
 */
export function checkMessage(state: TeamState, from: string, to: string, text: string): void {
  if (text.trim() === '') throw invalid('"text" must not be empty')
  const bytes = utf8Bytes(text)
  if (bytes > COLLABORATION_LIMITS.maxMessageBytes) {
    throw invalid(`a team message is at most ${COLLABORATION_LIMITS.maxMessageBytes} bytes (UTF-8); this one is ${bytes}`)
  }
  if (to === from) throw invalid('a member cannot send a message to itself')
  if (!isAddressable(state, to)) throw invalid(`unknown recipient "${to}"; the team is: ${roster(state)}`)
  const pending = pendingFor(state, to).length
  if (pending >= COLLABORATION_LIMITS.maxPendingMessagesPerMember) {
    throw new NexgentError('tool/denied', `"${to}" already has ${pending} undelivered messages (at most ${COLLABORATION_LIMITS.maxPendingMessagesPerMember}); wait until it reads them`)
  }
}

/** Input of {@link checkTaskCreate}. */
export interface TaskCreateInput {
  readonly title: string
  readonly description?: string
  readonly owner?: string
  readonly dependsOn?: readonly string[]
}

/**
 * Build a new board entry.
 * @throws `tool/invalid-input` for an empty title, an unknown owner or dependency, `tool/denied` when the board is full.
 */
export function checkTaskCreate(state: TeamState, input: TaskCreateInput): TeamTask {
  const title = input.title.trim()
  if (title === '') throw invalid('"title" must not be empty')
  if (state.tasks.size >= COLLABORATION_LIMITS.maxTeamTasks) throw new NexgentError('tool/denied', `the task board holds at most ${COLLABORATION_LIMITS.maxTeamTasks} tasks`)
  if (input.owner !== undefined && !isAddressable(state, input.owner)) throw invalid(`unknown owner "${input.owner}"; the team is: ${roster(state)}`)
  const dependsOn = [...new Set(input.dependsOn ?? [])]
  const unknown = dependsOn.filter(id => !state.tasks.has(id))
  if (unknown.length > 0) throw invalid(`unknown tasks in dependsOn: ${unknown.join(', ')}`, { dependsOn: unknown })
  const description = input.description?.trim()
  return {
    id: nextTaskId(state),
    title,
    ...(description === undefined || description === '' ? {} : { description }),
    status: 'pending',
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    dependsOn,
  }
}

/** Input of {@link checkTaskUpdate}. */
export interface TaskUpdateInput {
  readonly id: string
  readonly status?: TeamTaskStatus
  readonly owner?: string
  readonly result?: string
}

const FINAL: readonly TeamTaskStatus[] = ['completed', 'cancelled']

/**
 * Build the updated board entry for `actor` (`lead` or a teammate). A task
 * moves to `in_progress` only when every task it depends on is `completed`;
 * `completed` and `cancelled` are final. A teammate may change only tasks
 * that are unowned or its own, and claiming an unowned task makes it the
 * owner.
 * @throws `tool/invalid-input` naming what is wrong.
 */
export function checkTaskUpdate(state: TeamState, actor: string, input: TaskUpdateInput): TeamTask {
  const task = state.tasks.get(input.id)
  if (task === undefined) throw invalid(`unknown task "${input.id}"`)
  if (input.status === undefined && input.owner === undefined && input.result === undefined) {
    throw invalid('give at least one of status, owner or result')
  }
  if (FINAL.includes(task.status)) throw invalid(`task ${task.id} is already ${task.status}`)
  if (actor !== TEAM_LEAD_NAME && task.owner !== undefined && task.owner !== actor) {
    throw invalid(`task ${task.id} belongs to ${task.owner}; ask them or the lead`)
  }
  if (input.owner !== undefined && !isAddressable(state, input.owner)) throw invalid(`unknown owner "${input.owner}"; the team is: ${roster(state)}`)
  if (input.status === 'in_progress') {
    const open = task.dependsOn.filter(id => state.tasks.get(id)?.status !== 'completed')
    if (open.length > 0) {
      throw invalid(`task ${task.id} cannot start: it waits for ${open.map(id => `${id} (${state.tasks.get(id)?.status ?? 'unknown'})`).join(', ')}`, { waitingFor: open })
    }
  }
  const owner = input.owner ?? (task.owner === undefined && input.status === 'in_progress' && actor !== TEAM_LEAD_NAME ? actor : task.owner)
  const result = input.result?.trim()
  return {
    ...task,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(owner === undefined ? {} : { owner }),
    ...(result === undefined || result === '' ? {} : { result }),
  }
}

/** The board and roster as text (what the deleted `team_task_list` showed). */
export function renderBoard(state: TeamState, running: ReadonlySet<string> = new Set()): string {
  const members = [...state.members.values()].map(member => `${member.name} (${member.status}${running.has(member.name) ? ', running' : ''})`)
  const lines = [`Team: ${TEAM_LEAD_NAME}${members.length === 0 ? '' : `, ${members.join(', ')}`}`]
  if (state.tasks.size === 0) {
    lines.push('Tasks: none.')
  } else {
    lines.push('Tasks:')
    for (const task of state.tasks.values()) {
      const extras = [
        task.owner === undefined ? 'unowned' : `owner ${task.owner}`,
        ...(task.dependsOn.length === 0 ? [] : [`waits for ${task.dependsOn.join(', ')}`]),
      ]
      lines.push(`- ${task.id} [${task.status}] ${task.title} (${extras.join('; ')})`)
      if (task.description !== undefined) lines.push(`  ${task.description}`)
      if (task.result !== undefined) lines.push(`  Result: ${task.result}`)
    }
  }
  return lines.join('\n')
}

/** Marker opening an injected message; recovery finds delivered messages by it. */
export function messageMarker(id: string): string {
  return `<team-message id="${id}"`
}

/** How a message appears in its recipient's conversation (`user.message { source: 'inject' }`). */
export function renderInjectedMessage(message: Pick<TeamMessage, 'id' | 'from' | 'text'>): string {
  return `${messageMarker(message.id)} from="${message.from}">\n${message.text}\n</team-message>`
}

/** Ids of team messages a session's injected user messages (or, for the Lead, its tool results) carry. Pure. */
export function deliveredIds(records: readonly SessionRecord[]): Set<string> {
  const ids = new Set<string>()
  const pattern = /<team-message id="([0-9a-f-]{36})"/g
  for (const record of records) {
    let text: string | undefined
    if (record.type === 'user.message' && record.source === 'inject') text = record.content
    else if (record.type === 'tool.result') text = record.content
    if (text === undefined) continue
    for (const match of text.matchAll(pattern)) ids.add(match[1]!)
  }
  return ids
}
