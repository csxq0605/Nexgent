/**
 * Pure approval policy (`permissions.md` §工具审批): what a tool call needs
 * in a sandbox mode, what an approval request shows, and whether a standing
 * grant admits a call.
 */
import type { ApprovalSubject } from './contracts/approvals.js'
import type { ApprovalGrant, ApprovalRisk, ApprovalScope } from './contracts/approvals.js'
import type { ToolDefinition } from './contracts/tools.js'
import type { SandboxMode } from './contracts/workspace.js'
import { lexWords, parseScript, quoteWords } from './command-parse.js'

/** What policy says about one call before it runs. */
export type ToolPolicyVerdict =
  | { readonly kind: 'run' }
  | { readonly kind: 'ask'; readonly risk: ApprovalRisk; readonly options: readonly ApprovalScope[] }
  | { readonly kind: 'deny'; readonly reason: string }

const ALL_SCOPES: readonly ApprovalScope[] = ['once', 'session', 'project']

/** A call the tool itself declares read-only (`ToolDefinition.readOnlyCall`); a throwing check counts as "not read-only". */
export function isReadOnlyCall(definition: Pick<ToolDefinition, 'readOnlyCall'>, input: unknown): boolean {
  if (definition.readOnlyCall === undefined || input === undefined) return false
  try {
    return definition.readOnlyCall(input) === true
  } catch {
    return false
  }
}

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
 *
 * A tool that declares `selfSandboxed: true` (step 3: `run_code`) is exempt
 * from the `read-only` refusal: it checks each read and write against the
 * session's mode itself (`permissions.md` §工具审批).
 *
 * ADR 0022 decision 4: a tool with `readOnlyCall` and an `input` for which it
 * answers true (a shell command made only of read-only commands) is treated
 * as a read in `read-only` mode: it is not refused, and its risk is `low`.
 */
export function decideToolPolicy(definition: ToolDefinition, mode: SandboxMode, input?: unknown): ToolPolicyVerdict {
  const readOnlyCall = isReadOnlyCall(definition, input)
  if (mode === 'read-only' && mutates(definition) && definition.selfSandboxed !== true && !readOnlyCall) {
    return { kind: 'deny', reason: `SANDBOX_DENIED: ${definition.name} needs ${definition.effects.join('/')} access, but the session is read-only` }
  }
  if (definition.approval === 'always') return { kind: 'ask', risk: 'high', options: ['once'] }
  if (definition.approval === 'never') return { kind: 'run' }
  if (mode === 'full-access') return { kind: 'run' }
  return {
    kind: 'ask',
    risk: !readOnlyCall && definition.effects.includes('execute') ? 'medium' : 'low',
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
 * Pattern a `session` / `project` grant stores for a subject: for a command the
 * full word sequence of its first simple command (ADR 0022 decision 3), the
 * path itself for a path, nothing for other calls.
 */
export function derivePattern(subject: ApprovalSubject): string | undefined {
  if (subject.kind === 'command') {
    const first = parseScript(subject.value).commands.find(command => command.words.length > 0)
    return first === undefined ? undefined : quoteWords(first.words)
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

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, index) => word === b[index])
}

/**
 * Whether a standing grant admits a call of `tool` on `subject`.
 *
 * Command grants (ADR 0022 decision 3) hold the full word sequence of one
 * simple command. The subject is parsed into its simple commands (wrappers
 * unwrapped) and the grant admits it only when every one of them is exactly
 * that word sequence, compared whole word by whole word: `git push` does not
 * admit `git pushfoo` or `git push --force`. Pass a single flagged segment
 * (or several joined by a newline to require one grant for all of them).
 * Path grants keep glob semantics.
 */
export function grantMatches(grant: ApprovalGrant, tool: string, subject: ApprovalSubject): boolean {
  if (grant.tool !== tool) return false
  if (grant.pattern === undefined) return true
  switch (subject.kind) {
    case 'command': {
      const pattern = lexWords(grant.pattern)
      if (pattern.length === 0) return false
      const commands = parseScript(subject.value).commands.filter(command => command.words.length > 0)
      return commands.length > 0 && commands.every(command => sameWords(command.words, pattern) || (command.privilegeWords !== undefined && sameWords(command.privilegeWords, pattern)))
    }
    case 'path': {
      const pattern = grant.pattern.replaceAll('\\', '/')
      // `<dir>/**` (a directory grant, ADR 0022 decision 2) covers the directory itself too.
      return globMatch(pattern, subject.value) || (pattern.endsWith('/**') && subject.value.replace(/\/$/, '') === pattern.slice(0, -3))
    }
    default:
      return subject.value === grant.pattern
  }
}
