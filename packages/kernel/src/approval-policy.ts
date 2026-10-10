/**
 * Pure approval policy (`permissions.md` §工具审批): what a tool call needs
 * in a sandbox mode, what an approval request shows, and whether a standing
 * grant admits a call.
 */
import type { ApprovalSubject } from './contracts/approvals.js'
import type { ApprovalGrant, ApprovalRisk, ApprovalScope } from './contracts/approvals.js'
import type { ToolDefinition } from './contracts/tools.js'
import type { SandboxMode } from './contracts/workspace.js'

/** What policy says about one call before it runs. */
export type ToolPolicyVerdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'ask'; readonly risk: ApprovalRisk; readonly options: readonly ApprovalScope[] }
  | { readonly kind: 'deny'; readonly reason: string }

const ALL_SCOPES: readonly ApprovalScope[] = ['once', 'session', 'project']

function mutates(definition: ToolDefinition): boolean {
  return definition.effects.includes('write') || definition.effects.includes('execute')
}

/**
 * Decide a call from its definition and the session's sandbox mode:
 *
 * | mode | `never` | `ask` | `always` |
 * | --- | --- | --- | --- |
 * | `read-only` | run, unless write/execute → deny | deny if write/execute, else ask | deny if write/execute, else ask (once) |
 * | `workspace-write` | run | ask | ask (once) |
 * | `full-access` | run | run | ask (once) |
 */
export function decideToolPolicy(definition: ToolDefinition, mode: SandboxMode): ToolPolicyVerdict {
  if (mode === 'read-only' && mutates(definition)) {
    return { kind: 'deny', reason: `SANDBOX_DENIED: ${definition.name} needs ${definition.effects.join('/')} access, but the session is read-only` }
  }
  if (definition.approval === 'always') return { kind: 'ask', risk: 'high', options: ['once'] }
  if (definition.approval === 'never') return { kind: 'run' }
  if (mode === 'full-access') return { kind: 'run' }
  return {
    kind: 'ask',
    risk: definition.effects.includes('execute') ? 'medium' : 'low',
    options: ALL_SCOPES,
  }
}

/** The thing a call acts on, as far as approval is concerned. */
export type { ApprovalSubject } from './contracts/approvals.js'

const MAX_SUMMARY = 500

/** Extract the subject from parsed arguments (`command`, then `path` / `file_path`). */
export function approvalSubject(input: unknown): ApprovalSubject {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const args = input as Record<string, unknown>
    if (typeof args.command === 'string') return { kind: 'command', value: args.command }
    for (const key of ['path', 'file_path', 'file']) {
      if (typeof args[key] === 'string') return { kind: 'path', value: (args[key] as string).replaceAll('\\', '/') }
    }
  }
  const text = JSON.stringify(input) ?? ''
  return { kind: 'other', value: text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text }
}

/**
 * Pattern a `session` / `project` grant stores for a subject: the first two
 * words of a command, the path itself, nothing for other calls.
 */
export function derivePattern(subject: ApprovalSubject): string | undefined {
  if (subject.kind === 'command') {
    const words = subject.value.trim().split(/\s+/).filter(Boolean)
    return words.length === 0 ? undefined : words.slice(0, 2).join(' ')
  }
  if (subject.kind === 'path') return subject.value
  return undefined
}

/** Minimal glob: `**` spans separators, `*` and `?` do not. Paths use `/`. */
export function globMatch(pattern: string, path: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i += 1
      if (pattern[i + 1] === '/') i += 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`).test(path)
}

/** Whether a standing grant admits a call of `tool` on `subject`. */
export function grantMatches(grant: ApprovalGrant, tool: string, subject: ApprovalSubject): boolean {
  if (grant.tool !== tool) return false
  if (grant.pattern === undefined) return true
  switch (subject.kind) {
    case 'command': {
      const command = subject.value.trim()
      return command === grant.pattern || command.startsWith(`${grant.pattern} `) || command.startsWith(`${grant.pattern}\t`)
    }
    case 'path':
      return globMatch(grant.pattern.replaceAll('\\', '/'), subject.value)
    default:
      return subject.value === grant.pattern
  }
}
