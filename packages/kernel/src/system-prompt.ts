/**
 * System-prompt assembly: the profile's persona (PR #4 `system-prompt` row),
 * workspace facts and the visible tool list, rendered fresh for every
 * request and never stored in the session.
 */
import type { ToolDefinition } from './contracts/tools.js'
import type { SandboxMode } from './contracts/workspace.js'

/** Persona text from the profile; `{{model}}` and `{{cwd}}` are substituted. */
export interface SystemPromptTemplate {
  /** Opening paragraph. */
  readonly persona: string
  /** Closing line. */
  readonly suffix: string
}

/** PR #4 `cordis.patch.yml` `system-prompt.personaPrefix` (wording of the model mention adjusted for the Claude route; the delegation/workflow sentence is left out until step 3 adds those capabilities). */
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
 * Step-2 file-tool guidance (step-2 work partition, W0 → W7): edit existing
 * files with `str_replace`, create them with `write_file`, and declare
 * deliverables with `present`. Each line appears only when its tools are
 * offered, so the prompt never names a tool the model cannot call.
 */
function fileGuidance(tools: ReadonlySet<string>): string[] {
  const lines: string[] = []
  const shell = tools.has('bash') || tools.has('pwsh')
  if (tools.has('str_replace')) {
    lines.push(`- To change an existing file, use \`str_replace\`${tools.has('read_file') ? ' (read the file with `read_file` first)' : ''}${shell ? '; do not rewrite files through shell commands (heredocs, sed, inline scripts)' : ''}.`)
  }
  if (tools.has('write_file')) lines.push('- To create a new file or replace a file completely, use `write_file`.')
  if (tools.has('present')) lines.push('- When a file is a result for the user, declare it with `present` once it is ready, and again after each revision.')
  return lines
}

/** Render the system prompt. Deterministic for equal input (no clock), so the prefix stays cacheable. */
export function renderSystemPrompt(input: SystemPromptInput): string {
  const values = { model: input.model, cwd: input.cwd }
  const sections = [fill(input.template.persona, values).trim()]
  const shell = input.platform === 'win32' ? 'PowerShell (pwsh)' : 'bash'
  sections.push([
    '# Environment',
    `- Platform: ${input.platform}; shell: ${shell}.`,
    `- Sandbox mode: ${SANDBOX_TEXT[input.sandboxMode]}`,
    '- Relative paths resolve against the project directory. `.nexgent/` holds Nexgent\'s own data; do not edit it.',
    '- If a tool call is denied, choose another approach or explain what permission is needed.',
  ].join('\n'))
  if (input.tools.length > 0) {
    sections.push(['# Tools', ...input.tools.map(tool => `- ${tool.name}: ${tool.description.split('\n')[0]}`)].join('\n'))
  }
  const guidance = fileGuidance(new Set(input.tools.map(tool => tool.name)))
  if (guidance.length > 0) sections.push(['# Working with files', ...guidance].join('\n'))
  const suffix = fill(input.template.suffix, values).trim()
  if (suffix !== '') sections.push(suffix)
  return sections.join('\n\n')
}
