/**
 * System-prompt assembly: the profile's persona (PR #4 `system-prompt` row),
 * workspace facts and the visible tool list, rendered fresh for every
 * request and never stored in the session.
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
 * Step-2 file-tool guidance (step-2 work partition, W0 → W7): create files
 * with `write_file` (which refuses existing files), edit them with `str_replace`, keep the shell for running
 * things, and declare deliverables with `present`. Each line appears only
 * when its tools are offered, so the prompt never names a tool the model
 * cannot call. The shell line exists because a real run (step 2, R02) wrote
 * every file through heredocs and Python string replacement.
 */
function fileGuidance(tools: ReadonlySet<string>, materials: boolean): string[] {
  const lines: string[] = []
  const shells = ['bash', 'pwsh'].filter(name => tools.has(name)).map(name => `\`${name}\``)
  const write = tools.has('write_file')
  const edit = tools.has('str_replace')
  if (write) lines.push(`- To create a new file, use \`write_file\`; it refuses a file that already exists${edit ? ', so change existing files with `str_replace`' : ''}.`)
  if (edit) {
    lines.push(`- To change an existing file, use \`str_replace\`${tools.has('read_file') ? ' (read the file with `read_file` first)' : ''}; `
      + 'for several changes, call it once per change.')
  }
  if (shells.length > 0 && (write || edit)) {
    const own = [write ? '`write_file`' : undefined, edit ? '`str_replace`' : undefined].filter(Boolean).join(' and ')
    lines.push(`- Write and edit file contents only with ${own}. Do not create or modify files through ${shells.join(' or ')}: `
      + 'no heredocs (`cat > file <<EOF`), `echo >`, `tee`, `sed -i`, and no Python, Node or other scripts that write or rewrite a file. '
      + `Use ${shells.join(' or ')} to run programs, scripts and tests; files those programs produce (for example a report your script generates), and copying or moving files, are fine.`)
  }
  if (tools.has('present')) {
    lines.push('- When your work creates or changes project files for the user (code changes included), declare the files that make up the result with `present` before your final reply, and again after each revision; '
      + 'when presenting a revision, pass the `deliverableId` that `present` returned so it becomes a new version of the same deliverable.')
  }
  if (materials) lines.push('- Materials the user attached are under `.nexgent/materials/` and are read-only; read them there and write your results into the project.')
  return lines
}

/**
 * Step-3 form-choice principles (`agent-hooks.md` §步骤 3 系统提示增量 1):
 * only when a tool that starts members is offered, and naming only the
 * offered ones. Principles, not fixed roles or phases.
 */
function collaborationGuidance(tools: ReadonlySet<string>): string[] {
  const delegate = tools.has('delegate')
  const team = tools.has('spawn_teammate')
  const workflow = tools.has('workflow')
  if (!delegate && !team && !workflow) return []
  const lines = ['- By default, do the work yourself. Bring in members only when it clearly helps.']
  if (delegate) {
    lines.push('- Delegate a sub-task with `delegate` when it can be done on its own and has an output you can check. '
      + 'With `fresh` (default), write a self-contained task: the goal, the inputs, what to produce and where; use `fork` when the member needs this conversation so far.')
  }
  if (team) lines.push('- Form a team with `spawn_teammate` when several sub-tasks can run in parallel and need to talk to each other.')
  if (workflow) lines.push('- Use `workflow` when the steps are fixed and can be batched.')
  lines.push('- Members share the project directory: give each its own subdirectory to write into. Read their results yourself'
    + `${tools.has('present') ? ' and deliver the final result to the user with `present`' : ''}.`)
  return lines
}

/** The member identity block of a child session: the fixed line, then what a member is for. */
function memberBlock(member: Pick<MemberIdentity, 'name' | 'executionForm'>, tools: ReadonlySet<string>): string {
  return `${renderMemberPromptLine(member)}
`
    + 'You are a member of a larger task: do only the part you were given. '
    + `When you are done, ${tools.has('present') ? 'deliver your files with `present` and ' : ''}reply briefly with the result.`
}

/** Render the system prompt. Deterministic for equal input (no clock), so the prefix stays cacheable. */
export function renderSystemPrompt(input: SystemPromptInput): string {
  const values = { model: input.model, cwd: input.cwd }
  const names = new Set(input.tools.map(tool => tool.name))
  const sections = [fill(input.template.persona, values).trim()]
  if (input.member !== undefined) sections.push(memberBlock(input.member, names))
  const shell = input.platform === 'win32' ? 'PowerShell (pwsh)' : 'bash'
  sections.push([
    '# Environment',
    `- Platform: ${input.platform}; shell: ${shell}.`,
    `- Sandbox mode: ${SANDBOX_TEXT[input.sandboxMode]}${input.sandboxMode === 'read-only' && names.has('run_code') ? ' `run_code` still runs, but its writes are refused.' : ''}`,
    '- Relative paths resolve against the project directory. `.nexgent/` holds Nexgent\'s own data; do not edit it.',
    '- If a tool call is denied, choose another approach or explain what permission is needed.',
  ].join('\n'))
  if (input.tools.length > 0) {
    sections.push(['# Tools', ...input.tools.map(tool => `- ${tool.name}: ${tool.description.split('\n')[0]}`)].join('\n'))
  }
  const guidance = fileGuidance(names, input.materials === true)
  if (guidance.length > 0) sections.push(['# Working with files', ...guidance].join('\n'))
  const others = collaborationGuidance(names)
  if (others.length > 0) sections.push(['# Working with others', ...others].join('\n'))
  for (const section of input.sections ?? []) sections.push(`# ${section.title}\n${section.body}`)
  const suffix = fill(input.template.suffix, values).trim()
  if (suffix !== '') sections.push(suffix)
  return sections.join('\n\n')
}
