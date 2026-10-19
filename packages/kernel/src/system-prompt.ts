/**
 * System-prompt assembly: the profile's persona (PR #4 `system-prompt` row),
 * workspace facts and guidance that depends on which tools are offered,
 * rendered fresh for every request and never stored in the session. The
 * tool definitions themselves go with the request, not into the prompt (K2).
 */
import { renderMemberPromptLine, type MemberIdentity } from './contracts/collaboration.js'
import type { SystemPromptSection } from './contracts/context.js'
import type { ToolDefinition } from './contracts/tools.js'
import type { SandboxMode } from './contracts/workspace.js'

/** Persona text from the profile; `{{model}}` and `{{cwd}}` are substituted. */
export interface SystemPromptTemplate {
  /** Opening paragraph. */
  readonly persona: string
  /** Closing line. */
  readonly suffix: string
}

/** PR #4 `cordis.patch.yml` `system-prompt.personaPrefix` (wording of the model mention adjusted for the Claude route; the delegation/workflow guidance is the separate `# Working with others` section, shown only when those tools are offered). */
export const DEFAULT_PERSONA = 'You are Nexgent, a general task agent running on the {{model}} model. '
  + 'Complete the user\'s task with the available materials and tools. '
  + 'Verify actual deliverables, explain unresolved requirements, and preserve useful work for subsequent turns.'

/** PR #4 `cordis.patch.yml` `system-prompt.personaSuffix`. */
export const DEFAULT_PERSONA_SUFFIX = 'Your project working directory is {{cwd}}.'

/** Everything the prompt depends on. */
export interface SystemPromptInput {
  readonly template: SystemPromptTemplate
  readonly model: string
  /** Absolute project root. */
  readonly cwd: string
  readonly sandboxMode: SandboxMode
  /** `process.platform` of the host. */
  readonly platform: NodeJS.Platform
  /** Tools the model may call this request. */
  readonly tools: readonly ToolDefinition[]
  /**
   * Context-provider sections of the current turn (`agent-hooks.md`
   * §系统提示的组装), already in order; each renders as `# <title>` + body
   * after `# Working with files` and before the suffix.
   */
  readonly sections?: readonly SystemPromptSection[]
  /** Whether the project has materials (`.nexgent/materials/`); adds the read-only line to "Working with files". */
  readonly materials?: boolean
  /**
   * Step 3: set for a child session. Its identity line
   * (`renderMemberPromptLine`) follows the persona paragraph; root sessions
   * have none.
   */
  readonly member?: Pick<MemberIdentity, 'name' | 'executionForm'>
  /** Rework K4 D4: the member works in its own copy of the project (`cwd` is the copy). */
  readonly workdir?: boolean
  /** Rework K4 D4: members that may write get their own copies of the project (root sessions). */
  readonly memberWorkdirs?: boolean
}

const SANDBOX_TEXT: Record<SandboxMode, string> = {
  'read-only': 'read-only: you may read files inside the project; writes and commands are refused.',
  'workspace-write': 'workspace-write: you may read and write inside the project; some commands and sensitive files need the user\'s approval.',
  'full-access': 'full-access: WARNING, there is no sandbox; every action runs with the user\'s full permissions.',
}

function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

/**
 * File guidance that no tool description carries: when to declare a
 * deliverable, and where attached materials are. How to create and edit
 * files is in the file tools' own descriptions (K2: the earlier lines
 * repeated them and forbade writing files through the shell, a rule taken
 * from one step-2 run, ADR 0017 decision 1).
 */
function fileGuidance(tools: ReadonlySet<string>, materials: boolean): string[] {
  const lines: string[] = []
  if (tools.has('present')) {
    lines.push('- When the user asks for a result file (a report, a document, a table, a figure), declare it with `present` before your final reply, and again after each revision, '
      + 'passing the `deliverableId` that `present` returned so it becomes a new version of the same deliverable. Ordinary code edits need no `present`: the files you changed are shown to the user anyway.')
  }
  if (materials) lines.push('- Materials the user attached are read-only copies at the paths given with them; read them there and write your results into the project.')
  return lines
}

/**
 * Step-3 form-choice principles (`agent-hooks.md` §步骤 3 系统提示增量 1):
 * only when a tool that starts members is offered, and naming only the
 * offered ones. Principles, not fixed roles or phases.
 */
function collaborationGuidance(tools: ReadonlySet<string>, workdirs: boolean): string[] {
  const delegate = tools.has('delegate')
  const team = tools.has('spawn_teammate')
  const workflow = tools.has('workflow')
  if (!delegate && !team && !workflow) return []
  const lines = ['- By default, do the work yourself. Bring in members only when it clearly helps.']
  if (delegate) {
    lines.push('- Delegate a sub-task with `delegate` when it can be done on its own and has an output you can check. '
      + 'With `fresh` (default), write a self-contained task: the goal, the inputs, what to produce and where; use `fork` when the member needs this conversation so far. '
      + 'Several `delegate` calls in one reply run at the same time, so put independent sub-tasks in the same reply.')
  }
  if (team) lines.push('- Form a team with `spawn_teammate` when several sub-tasks can run in parallel and need to talk to each other.')
  if (workflow) lines.push('- Use `workflow` when the plan is fixed and has dependencies, stages or many items that a short script should drive.')
  if (workdirs) {
    lines.push('- Each member that may write works in its own copy of the project; its changes are merged into the project when its turn ends, and a file changed both there and here is reported as a conflict for you to resolve. '
      + 'Still give each member its own part of the work. Read their results yourself'
      + `${tools.has('present') ? ' and deliver the final result to the user with `present`' : ''}.`)
  } else {
    lines.push('- Members share the project directory: tell each which files it may change, and never give two members that run at the same time the same file. Read their results yourself'
      + `${tools.has('present') ? ' and deliver the final result to the user with `present`' : ''}.`)
  }
  return lines
}

/** The member identity block of a child session: the fixed line, then what a member is for. */
function memberBlock(member: Pick<MemberIdentity, 'name' | 'executionForm'>, tools: ReadonlySet<string>, workdir: boolean): string {
  return `${renderMemberPromptLine(member)}
`
    + 'You are a member of a larger task: do only the part you were given. '
    + `When you are done, ${tools.has('present') ? 'deliver your files with `present` and ' : ''}reply briefly with the result.`
    + (workdir ? ' You work in your own copy of the project (the working directory below); what you change there is merged into the project when your turn ends.' : '')
}

/** Render the system prompt. Deterministic for equal input (no clock), so the prefix stays cacheable. */
export function renderSystemPrompt(input: SystemPromptInput): string {
  const values = { model: input.model, cwd: input.cwd }
  const names = new Set(input.tools.map(tool => tool.name))
  const sections = [fill(input.template.persona, values).trim()]
  if (input.member !== undefined) sections.push(memberBlock(input.member, names, input.workdir === true))
  const shell = input.platform === 'win32' ? 'PowerShell (pwsh)' : 'bash'
  sections.push([
    '# Environment',
    `- Platform: ${input.platform}; shell: ${shell}.`,
    `- Sandbox mode: ${SANDBOX_TEXT[input.sandboxMode]}${input.sandboxMode === 'read-only' && names.has('run_code') ? ' `run_code` still runs, but its writes are refused.' : ''}`,
    '- Relative paths resolve against the project directory. `.nexgent/` holds Nexgent\'s project settings; do not edit it.',
    '- If a tool call is denied, choose another approach or explain what permission is needed.',
  ].join('\n'))
  const guidance = fileGuidance(names, input.materials === true)
  if (guidance.length > 0) sections.push(['# Working with files', ...guidance].join('\n'))
  const others = collaborationGuidance(names, input.memberWorkdirs === true)
  if (others.length > 0) sections.push(['# Working with others', ...others].join('\n'))
  for (const section of input.sections ?? []) sections.push(`# ${section.title}\n${section.body}`)
  const suffix = fill(input.template.suffix, values).trim()
  if (suffix !== '') sections.push(suffix)
  return sections.join('\n\n')
}
