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

/** PR #4 `cordis.patch.yml` `system-prompt.personaPrefix`. */
export const DEFAULT_PERSONA = 'You are Nexgent, a general task agent using the {{model}} model. '
  + 'Complete the user\'s task with the available materials and tools. '
  + 'Choose direct work, delegation or a workflow according to the task. '
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
  const suffix = fill(input.template.suffix, values).trim()
  if (suffix !== '') sections.push(suffix)
  return sections.join('\n\n')
}
