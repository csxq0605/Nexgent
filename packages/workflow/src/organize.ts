/**
 * New direction step 2: Nexgent organizes a task itself.
 *
 * - {@link defaultOrganizer} (`ctx.organizer`) decides per root turn whether
 *   members help: a small task is done alone, and 1 in 5 of the others is
 *   done alone for comparison (the user's choice, 2026-10-19). Step 3
 *   replaces the rule with a choice learned from outcomes.
 * - `organize` starts the members of one organization (roles, their parts,
 *   who waits for whom) through the workflow runtime, asks each for a short
 *   report, and tells the model whether the organization made progress.
 *   When it did not, the model changes the organization in the same task
 *   (`organize` again with a reason; an identical organization is refused).
 *
 * Roles and organizations are generic: nothing here is about a kind of task.
 */
import { randomUUID } from 'node:crypto'
import {
  MEMBER_DENIED_TOOLS,
  MAX_ORGANIZATION_ROLES,
  MEMBER_NAME_PATTERN,
  memberReplyExcerpt,
  memberReplyShare,
  NexgentError,
  ORGANIZATION_NAMES,
  ORGANIZATION_ROLE_KINDS,
  ORGANIZE_TOOL,
  renderWorkdirMerge,
  type OrganizationDecision,
  type OrganizationName,
  type OrganizationRoleKind,
  type OrganizationUse,
  type SystemPromptSection,
  type Tool,
  type ToolOutput,
  type TurnOrganizer,
  type TurnOrganizerInput,
  type TurnOrganizationEnd,
  type OrganizationMemory,
  type OrganizationSuggestion,
} from '@nexgent/kernel'
import { prepareArchitecture } from './architecture.js'
import type { WorkflowMemberRunner } from './runner.js'
import { runWorkflow, type RunWorkflowOptions, type WorkflowMemberSummary } from './runtime.js'

// ---------------------------------------------------------------------------
// deciding whether members help
// ---------------------------------------------------------------------------

/** A task this short (CJK characters plus other words), on one line and without materials, is done alone. */
export const SMALL_TASK_UNITS = 40

/** Share of the tasks that could use members that are done alone for comparison. */
export const SOLO_CONTROL_RATE = 0.2

/** Size of a text: CJK characters count one each, other words one each. */
export function taskUnits(text: string): number {
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/gu)?.length ?? 0
  const words = text.replace(/[぀-ヿ㐀-鿿가-힯豈-﫿]/gu, ' ').match(/[\p{L}\p{N}_]+/gu)?.length ?? 0
  return cjk + words
}

/** Whether a task is small enough to be done without members. */
export function isSmallTask(text: string, materialIds: readonly string[] = []): boolean {
  const lines = text.split('\n').filter(line => line.trim() !== '').length
  return materialIds.length === 0 && lines <= 1 && taskUnits(text) <= SMALL_TASK_UNITS
}

/** The system section of a turn done alone. */
export const SOLO_SECTION: SystemPromptSection = {
  id: 'organization',
  title: 'How this task is organized',
  body: 'Nexgent handles this task without members: do it yourself.',
}

/** The system section of a turn members may help with. */
export const TEAM_SECTION: SystemPromptSection = {
  id: 'organization',
  title: 'How this task is organized',
  body: [
    'Nexgent decided to use members for this task: do not answer before members have worked on it. Use the organization named at the end of this section; when none is named, at the least use `lead-checker`: do the work, then call `organize` with a member that checks it independently, a `test` member when there is anything to run (tests, the program), a `review` member only when there is nothing to run. For the other organizations call `organize` before you write any file.',
    '- A `review` member can only read files; when checking needs commands (running the tests, trying the program), give that job to a `test` member.',
    '- Organizations: `lead-checker` (you do the work, then a `test` member, or a `review` member when there is nothing to run, checks it independently); '
      + '`plan-build-review` (a `plan` member splits the work, `implement` members build separate parts in parallel, a `review` member checks); '
      + '`explore-then-build` (`explore` members read different areas in parallel, then an `implement` member or you build); `custom` for any other arrangement.',
    '- Do the step everything else waits on yourself when it is short. Give members that run at the same time parts that change different files, and list in `after` the roles a role needs results from.',
    '- Each member ends with a short report (done, not done, checks, blockers). When the organization makes no progress or checks fail because of how the work was split, '
      + 'say why in one sentence and call `organize` again with that `reason` and a changed organization (another role, an added tester or reviewer, parts split or merged, one member given another\'s findings). Never repeat the same one.',
    '- Read the members\' results yourself and finish the task: you answer the user.',
  ].join('\n'),
}

/** Options of {@link defaultOrganizer}. */
export interface DefaultOrganizerOptions {
  /** Default {@link SOLO_CONTROL_RATE} (only without a library). */
  readonly controlRate?: number
  /** Default `Math.random` (tests pass a fixed sequence). */
  readonly random?: () => number
  /** Step 3: the organization library (`ctx.organizations`), looked up per turn. */
  readonly memory?: () => OrganizationMemory | undefined
}

/** Pure: the team section with the organization to start from. */
export function teamSection(organization: OrganizationSuggestion['organization']): SystemPromptSection {
  if (organization === undefined) return TEAM_SECTION
  const roles = organization.roles === undefined || organization.roles.length === 0
    ? ''
    : ` with these roles: ${organization.roles.map(role => `${role.name} (${role.kind}${role.after.length > 0 ? `, after ${role.after.join(', ')}` : ''})`).join('; ')}`
  const lead = organization.roles === undefined
    ? `- Use \`${organization.name}\` for this task: Nexgent compares organizations across similar tasks, so do not swap it for a smaller one because the task looks easy.`
    : `- On similar tasks \`${organization.name}\`${roles} went well. Start from it and give each role this task's part.`
  return { ...TEAM_SECTION, body: `${TEAM_SECTION.body}\n${lead} Use another organization only when this task clearly needs it.` }
}

/**
 * Phrases of a follow-up message saying the previous result is wrong or
 * must be redone or undone (Chinese and English). Only the message's first
 * sentence is read; verbs that could start a new task (重做、撤销, redo,
 * undo …) count only as its first words, the unambiguous phrases anywhere in
 * it. Only a session with a recorded turn is marked.
 */
const REDO_OPENINGS = ['重做', '重来', '不对', '错了', '改回', '撤销', '撤回', '回退', '退回', '还原']
const REDO_ANYWHERE = ['恢复原样', '不是这样', '不是我要的', '没改对', '没做对', '改回去', '做错了', '改错了']
const REDO_OPENING_PATTERN = /^(?:(?:no|nope|hmm|please|pls)[\s,.!]*)*(?:redo|undo|revert|roll ?back|start over|wrong)\b/i
const REDO_ANYWHERE_PATTERN = /\b(?:that'?s wrong|this is wrong|it'?s wrong|not what i (?:asked|wanted|meant)|(?:doesn'?t|does not|didn'?t|did not) work)\b/i

/** Pure: whether a follow-up message says the previous result is wrong or must be redone. */
export function asksRedo(text: string): boolean {
  const first = text.trim().split(/[。！？!?\n]|\.\s/u)[0]!.slice(0, 80)
  const opening = first.replace(/^[\s嗯啊哎呃，,、]+/u, '')
  return REDO_OPENINGS.some(phrase => opening.startsWith(phrase)) || REDO_ANYWHERE.some(phrase => first.includes(phrase))
    || REDO_OPENING_PATTERN.test(opening) || REDO_ANYWHERE_PATTERN.test(first)
}

/** Pure: what a turn did, as organization-library traits (sorted, deduplicated). */
export function turnTraits(input: Pick<TurnOrganizationEnd, 'tools' | 'changes' | 'checks'>): string[] {
  const coordination = new Set<string>(MEMBER_DENIED_TOOLS)
  const out = new Set<string>()
  for (const change of input.changes) {
    if (change.change === 'deleted') continue
    const name = change.path.split('/').at(-1) ?? ''
    const dot = name.lastIndexOf('.')
    if (dot > 0 && dot < name.length - 1) out.add(`ext:${name.slice(dot + 1).toLowerCase()}`)
  }
  for (const tool of input.tools) if (!coordination.has(tool)) out.add(`tool:${tool}`)
  for (const check of input.checks ?? []) out.add(`check:${check.name}`)
  return [...out].sort()
}

/** A user-asked change to a result: feedback without a rating, or rated 3 or lower. */
function asksRework(rating: number | undefined): boolean {
  return rating === undefined || rating <= 3
}

/**
 * The `ctx.organizer`: small tasks alone; with the organization library
 * (step 3) what worked on similar tasks decides the rest, and every turn it
 * decided is recorded when it ends; without one, a share of the others alone
 * for comparison and members for the rest. A feedback turn asking for
 * changes marks the session's last recorded turn as reworked; feedback turns
 * themselves are not recorded (they are not new tasks).
 */
export function defaultOrganizer(options: DefaultOrganizerOptions = {}): TurnOrganizer {
  const rate = options.controlRate ?? SOLO_CONTROL_RATE
  const random = options.random ?? Math.random
  const pending = new Map<string, { readonly turn: number; readonly suggestion: OrganizationSuggestion }>()
  return {
    async decide(input: TurnOrganizerInput) {
      const memory = options.memory?.()
      const redo = input.source === 'feedback' ? asksRework(input.rating) : input.turn > 1 && asksRedo(input.text)
      if (memory !== undefined && redo) await memory.noteRework({ sessionId: input.sessionId }).catch(() => undefined)
      // "Try another way": a retry copy runs the organization it was given, whatever the task's size.
      const forced = await memory?.forced?.().catch(() => undefined)
      if (forced !== undefined) {
        const decision: OrganizationDecision = { decision: forced.decision, chosenBy: 'retry', ...(forced.decision === 'team' && forced.organization !== undefined ? { suggested: forced.organization } : {}) }
        return { decision, section: forced.decision === 'solo' ? SOLO_SECTION : teamSection(forced.organization === undefined ? undefined : { name: forced.organization }) }
      }
      if (isSmallTask(input.text, input.materialIds)) return { decision: { decision: 'solo', chosenBy: 'size' }, section: SOLO_SECTION }
      const suggestion = memory !== undefined && input.source === 'user' ? await memory.suggest({ text: input.text, random }).catch(() => undefined) : undefined
      if (suggestion !== undefined) {
        pending.set(input.sessionId, { turn: input.turn, suggestion })
        const decision: OrganizationDecision = {
          decision: suggestion.decision,
          chosenBy: suggestion.control ? 'control' : suggestion.runs > 0 ? 'memory' : 'default',
          ...(suggestion.organization === undefined ? {} : { suggested: suggestion.organization.name }),
        }
        return { decision, section: decision.decision === 'solo' ? SOLO_SECTION : teamSection(suggestion.organization) }
      }
      const decision: OrganizationDecision = random() < rate ? { decision: 'solo', chosenBy: 'control' } : { decision: 'team', chosenBy: 'default' }
      return { decision, section: decision.decision === 'solo' ? SOLO_SECTION : TEAM_SECTION }
    },
    async noteTurnEnd(input: TurnOrganizationEnd) {
      const entry = pending.get(input.sessionId)
      if (entry === undefined || entry.turn !== input.turn) return
      pending.delete(input.sessionId)
      const memory = options.memory?.()
      if (memory === undefined) return
      // Results of earlier turns the user has since deleted count as rework.
      await memory.noteReverts({ projectRoot: input.projectRoot }).catch(() => undefined)
      const checks = input.checks ?? []
      const deleted = input.changes.filter(change => change.change === 'deleted').map(change => change.path)
      const gone = new Set(deleted)
      const outputs = input.presented.filter(path => !gone.has(path))
      const traits = turnTraits(input)
      await memory.record({
        classId: entry.suggestion.classId,
        key: entry.suggestion.key,
        sessionId: input.sessionId,
        turn: input.turn,
        decision: input.use.decision,
        control: entry.suggestion.control,
        ...(input.organization === undefined ? {} : { organization: input.organization }),
        reorganizations: input.use.reorganizations,
        corrections: input.use.corrections,
        ...(checks.length === 0 ? {} : { checks: { passed: checks.filter(check => check.passed).length, total: checks.length } }),
        completed: input.reason.kind === 'completed',
        usd: input.usd,
        projectRoot: input.projectRoot,
        ...(traits.length === 0 ? {} : { traits }),
        ...(outputs.length === 0 ? {} : { outputs }),
        ...(deleted.length === 0 ? {} : { deleted }),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

/** The built-in preset each role kind runs with (its tools and persona). */
export const ROLE_PRESETS: Readonly<Record<OrganizationRoleKind, string>> = {
  plan: 'read-only-analyst',
  explore: 'explorer',
  implement: 'general-executor',
  test: 'general-executor',
  review: 'read-only-checker',
}

/** What a role is for, opening its member's prompt. */
export const ROLE_INTROS: Readonly<Record<OrganizationRoleKind, string>> = {
  plan: 'You are the planner of a team. Read what you need and split the work into parts that can be done separately; for each part name the files it changes and how to check it. Do not change files.',
  explore: 'You are an explorer in a team. Find and read what the task needs and report the facts the others will build on (paths, names, how things work). Do not change files.',
  implement: 'You are an implementer in a team. Make the change of your part below, only in the files of your part.',
  test: 'You are the tester of a team. Write or run tests for the work below and report exactly what passes and what fails.',
  review: 'You are the reviewer of a team. Check the work below against its task: read the changed files and report concrete problems. You can read files but cannot run commands; leave running checks to the tester and say what you could not check. Do not change files.',
}

/** Closes every member's prompt: the report the organizer reads. */
export const MEMBER_REPORT_INSTRUCTION = 'End your reply with these four lines:\n'
  + 'Done: what you finished\n'
  + 'Not done: what is left (or "none")\n'
  + 'Checks: what you ran or verified and the result (or "none")\n'
  + 'Blockers: what stopped you (or "none")'

/** A member's report, from the last lines of its reply that carry the four labels. */
export interface MemberReport {
  readonly done?: string
  readonly notDone?: string
  readonly checks?: string
  readonly blockers?: string
}

const REPORT_LABELS: readonly [keyof MemberReport, RegExp][] = [
  ['notDone', /^\W*not done\W*:\s*(.*)$/i],
  ['done', /^\W*done\W*:\s*(.*)$/i],
  ['checks', /^\W*checks?\W*:\s*(.*)$/i],
  ['blockers', /^\W*blockers?\W*:\s*(.*)$/i],
]

/** Parse a member's report (the last line of each label wins). */
export function parseMemberReport(text: string): MemberReport {
  const report: Record<string, string> = {}
  for (const line of text.split('\n')) {
    for (const [key, pattern] of REPORT_LABELS) {
      const match = pattern.exec(line.trim())
      if (match !== null) {
        report[key] = match[1]!.trim()
        break
      }
    }
  }
  return report
}

/** Whether a report field says something is there (not empty, not "none"). */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== '' && !/^(none|nothing|n\/a|no|-|—|无|没有)\W*$/i.test(value)
}

/** What a member's report says stopped it (its `Blockers:` line), or undefined when it names none. */
export function reportBlocker(text: string): string | undefined {
  const { blockers } = parseMemberReport(text)
  return present(blockers) ? blockers : undefined
}

/** Whether a report's checks say something failed. */
function checksFailed(value: string | undefined): boolean {
  if (!present(value)) return false
  return /\bfail(s|ed|ing|ure|ures)?\b|\berrors?\b|失败|报错/i.test(value!) && !/\b(0|no|zero) (failures?|failed|errors?)\b|没有失败|无失败/i.test(value!)
}

/** One role's state after a run. */
export interface RoleProgress {
  readonly name: string
  readonly kind: OrganizationRoleKind
  /** `not-run`: it waited for a role that failed. */
  readonly status: WorkflowMemberSummary['status'] | 'not-run'
  readonly report: MemberReport
  /** Completed with nothing left, no blocker and no failed check. */
  readonly ok: boolean
}

/** Each role's progress after a run. */
export function roleProgress(roles: readonly { readonly name: string; readonly kind: OrganizationRoleKind }[], members: readonly WorkflowMemberSummary[]): RoleProgress[] {
  return roles.map(role => {
    const member = members.find(item => item.name === role.name)
    if (member === undefined) return { name: role.name, kind: role.kind, status: 'not-run', report: {}, ok: false }
    const report = parseMemberReport(member.text)
    const ok = member.status === 'completed' && !present(report.notDone) && !present(report.blockers) && !checksFailed(report.checks)
    return { name: role.name, kind: role.kind, status: member.status, report, ok }
  })
}

// ---------------------------------------------------------------------------
// the organize tool
// ---------------------------------------------------------------------------

/** Model-facing description of `organize`. */
export const ORGANIZE_DESCRIPTION = 'Start the members of one organization of this task and wait for all of them. '
  + 'Give the organization, and one role per member: a name, a kind (plan, explore, implement, test, review), its part of the task '
  + '(goal, inputs, what to produce and where; members see only this text and the results of the roles in `after`), and `after` for the roles it waits for. '
  + 'Roles without `after` run at the same time. Each member works in its own copy of the project; its changes are merged back when it ends, and conflicts are reported to you. '
  + 'The result has each member\'s reply, its report, and whether the organization made progress. '
  + 'To change the organization of this task, call organize again with a `reason`. '
  + 'To give one member a follow-up, call delegate with its name and member id as continue.'

/** Parsed `organize` input. */
export interface OrganizeInput {
  readonly organization: OrganizationName
  readonly reason?: string
  readonly roles: readonly { readonly name: string; readonly kind: OrganizationRoleKind; readonly task: string; readonly after: readonly string[] }[]
}

/** Check the model's arguments. @throws `tool/invalid-input`. */
export function parseOrganizeInput(input: unknown): OrganizeInput {
  const args = (input ?? {}) as Record<string, unknown>
  const invalid = (message: string) => new NexgentError('tool/invalid-input', message)
  if (!(ORGANIZATION_NAMES as readonly unknown[]).includes(args.organization)) throw invalid(`"organization" must be one of ${ORGANIZATION_NAMES.join(', ')}`)
  if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.trim() === '')) throw invalid('"reason" must be a non-empty string')
  if (!Array.isArray(args.roles) || args.roles.length === 0 || args.roles.length > MAX_ORGANIZATION_ROLES) throw invalid(`"roles" must list 1 to ${MAX_ORGANIZATION_ROLES} roles`)
  const names = new Set<string>()
  const roles = args.roles.map((value, index) => {
    const role = (value ?? {}) as Record<string, unknown>
    if (typeof role.name !== 'string' || !MEMBER_NAME_PATTERN.test(role.name)) throw invalid(`roles[${index}].name must be lowercase letters, digits and dashes, starting with a letter`)
    if (names.has(role.name)) throw invalid(`two roles are named "${role.name}"`)
    names.add(role.name)
    if (!(ORGANIZATION_ROLE_KINDS as readonly unknown[]).includes(role.kind)) throw invalid(`roles[${index}].kind must be one of ${ORGANIZATION_ROLE_KINDS.join(', ')}`)
    if (typeof role.task !== 'string' || role.task.trim() === '') throw invalid(`roles[${index}].task must be a non-empty string`)
    const after = role.after ?? []
    if (!Array.isArray(after) || after.some(item => typeof item !== 'string')) throw invalid(`roles[${index}].after must be a list of role names`)
    return { name: role.name, kind: role.kind as OrganizationRoleKind, task: role.task.trim(), after: [...new Set(after as string[])] }
  })
  for (const role of roles) {
    for (const dependency of role.after) {
      if (!names.has(dependency)) throw invalid(`role "${role.name}" waits for "${dependency}", which is not a role`)
      if (dependency === role.name) throw invalid(`role "${role.name}" waits for itself`)
    }
  }
  return { organization: args.organization as OrganizationName, ...(typeof args.reason === 'string' ? { reason: args.reason.trim() } : {}), roles }
}

/** Same roles, kinds, parts and order of work. */
function signature(input: OrganizeInput): string {
  return JSON.stringify([input.organization, ...input.roles.map(role => [role.name, role.kind, role.task, [...role.after].sort()])])
}

/** The prompt of one role's member (the workflow appends the results of the roles in `after`). */
export function renderRolePrompt(kind: OrganizationRoleKind, task: string): string {
  return `${ROLE_INTROS[kind]}\n\nYour part:\n${task}\n\n${MEMBER_REPORT_INSTRUCTION}`
}

/** What the tool needs from the open agent of the calling session. */
export interface OrganizeAgentLookup {
  (sessionId: string): { organizationUse(): OrganizationUse | undefined } | undefined
}

/** Options of {@link organizeTool}. */
export interface OrganizeToolOptions {
  readonly runner: WorkflowMemberRunner
  /** The calling session's agent (`ctx.agents.get`), for the turn's decision. */
  readonly agent?: OrganizeAgentLookup
  readonly ptc?: RunWorkflowOptions['ptc']
  readonly maxConcurrentMembers?: number
  readonly maxMembers?: number
}

/** Per root session: the organization its current turn runs, and how many in a row made no progress. */
interface TurnState {
  readonly turn: number
  organizationId?: string
  signature?: string
  stalls: number
}

const KIND_LABEL: Readonly<Record<OrganizationRoleKind, string>> = { plan: 'plan', explore: 'explore', implement: 'implement', test: 'test', review: 'review' }

function renderProgress(name: OrganizationName, progress: readonly RoleProgress[], stalls: number, status: string): string[] {
  const lines = ['', '## Progress', `Organization ${name}: ${progress.filter(role => role.ok).length} of ${progress.length} roles done (workflow ${status}).`]
  for (const role of progress) {
    const parts = [`- ${role.name} (${KIND_LABEL[role.kind]}): ${role.ok ? 'done' : role.status === 'completed' ? 'completed with open items' : role.status}`]
    if (present(role.report.notDone)) parts.push(`not done: ${role.report.notDone}`)
    if (present(role.report.checks)) parts.push(`checks: ${role.report.checks}`)
    if (present(role.report.blockers)) parts.push(`blockers: ${role.report.blockers}`)
    lines.push(parts.join('; '))
  }
  if (progress.every(role => role.ok)) {
    lines.push('', 'Every role reports done. Read their results, check the whole, and finish the task.')
  } else if (stalls === 0) {
    lines.push('', 'Some roles are done. Finish what is left yourself, give a member a follow-up with delegate (continue), or change the organization for the rest.')
  } else {
    lines.push('', stalls === 1
      ? 'This organization made no progress. Say in one sentence why, then call organize again with that reason and a changed organization, or do the work yourself.'
      : `No progress ${stalls} times in a row. Change the organization substantially (other roles, merged or split parts) or do the rest yourself.`)
  }
  return lines
}

/** The `organize` tool over a member runner. */
export function organizeTool(options: OrganizeToolOptions): Tool {
  const turns = new Map<string, TurnState>()
  return {
    definition: {
      name: ORGANIZE_TOOL.name,
      description: ORGANIZE_DESCRIPTION,
      inputSchema: ORGANIZE_TOOL.inputSchema,
      effects: ORGANIZE_TOOL.effects,
      approval: ORGANIZE_TOOL.approval,
    },
    handler: async (raw, context): Promise<ToolOutput> => {
      if (context.member !== undefined) throw new NexgentError('tool/denied', 'members cannot organize members')
      const appendRecord = context.appendRecord
      if (appendRecord === undefined) throw new NexgentError('tool/failed', 'this host cannot record organizations (no tool records)')
      const use = options.agent?.(context.sessionId)?.organizationUse()
      if (use?.decision === 'solo') {
        throw new NexgentError('tool/denied', 'Nexgent handles this task without members: do it yourself.')
      }
      const input = parseOrganizeInput(raw)
      let state = turns.get(context.sessionId)
      if (state === undefined || state.turn !== context.turn) {
        state = { turn: context.turn, stalls: 0 }
        turns.set(context.sessionId, state)
      }
      const replaces = state.organizationId
      if (replaces !== undefined && input.reason === undefined) {
        throw new NexgentError('tool/invalid-input', 'this task already ran an organization: give the reason you are changing it')
      }
      const sig = signature(input)
      if (sig === state.signature) throw new NexgentError('tool/invalid-input', 'this is the organization that just ran: change the roles, their parts or their order')

      const organizationId = randomUUID()
      const workflowId = randomUUID()
      await appendRecord({
        type: 'organization',
        turn: context.turn,
        toolCallId: context.callId,
        organizationId,
        name: input.organization,
        roles: input.roles.map(role => ({ name: role.name, kind: role.kind, after: [...role.after] })),
        workflowId,
        ...(replaces === undefined ? {} : { replaces }),
        ...(replaces === undefined || input.reason === undefined ? {} : { reason: input.reason }),
      })
      state.organizationId = organizationId
      state.signature = sig

      const prepared = prepareArchitecture({
        nodes: input.roles.map(role => ({ id: role.name, prompt: renderRolePrompt(role.kind, role.task), dependencies: [...role.after], preset: ROLE_PRESETS[role.kind] })),
      })
      const result = await runWorkflow({
        script: prepared.script,
        kind: 'graph',
        architecture: prepared.version,
        title: input.organization,
        workflowId,
        runner: options.runner,
        parentSessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        appendRecord,
        cwd: context.workspace.root,
        signal: context.signal,
        ...(options.ptc === undefined ? {} : { ptc: options.ptc }),
        ...(options.maxConcurrentMembers === undefined ? {} : { maxConcurrentMembers: options.maxConcurrentMembers }),
        ...(options.maxMembers === undefined ? {} : { maxMembers: options.maxMembers }),
      })
      const progress = roleProgress(input.roles, result.members)
      state.stalls = progress.some(role => role.ok) ? 0 : state.stalls + 1

      const lines = [`Organization ${input.organization} ${result.status}: ${result.members.length} member${result.members.length === 1 ? '' : 's'} ran.`]
      if (result.error !== undefined) lines.push(`Error: ${result.error.message}`)
      const share = memberReplyShare(result.members.length)
      for (const member of result.members) {
        lines.push('', `## ${member.name} (${member.status}, member id ${member.childSessionId})`)
        if (member.files.length > 0) lines.push(`Files: ${member.files.join(', ')}`)
        lines.push(...renderWorkdirMerge(member.merge))
        if (member.text !== '') lines.push(memberReplyExcerpt(member.text, share))
      }
      lines.push(...renderProgress(input.organization, progress, state.stalls, result.status))
      return {
        content: lines.join('\n'),
        isError: result.status === 'cancelled',
        meta: {
          organizationId,
          workflowId,
          status: result.status,
          progress: progress.map(role => ({ name: role.name, kind: role.kind, status: role.status, ok: role.ok })),
          stalls: state.stalls,
        },
      }
    },
  }
}
