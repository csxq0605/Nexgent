/**
 * Shared tool plumbing: sandbox enforcement inside handlers, the approval
 * hand-off for escalated calls, grant matching, and an optional side-effect
 * free pre-check ("preflight").
 *
 * When the sandbox answers `ask` (blacklisted command, sensitive file,
 * always-ask table) the tool never prompts by itself. In the handler it:
 * 1. proceeds when the context carries `approved: true` (the caller already
 *    obtained approval, e.g. after `preflight`);
 * 2. otherwise calls `context.requestApproval(ask)` when the context has it
 *    (the kernel's `KernelToolContext`: grant matching, the broker, session
 *    and ledger records happen there) and proceeds only on `true`;
 * 3. otherwise fails closed with `approval/denied`.
 * Denials throw `sandbox/denied` (`SANDBOX_DENIED { mode, path | command }`)
 * without any approval request.
 */
import {
  NexgentError,
  toErrorInfo,
  type ApprovalGrant,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalScope,
  type ErrorInfo,
  type JsonObject,
  type Tool,
  type ToolApprovalAsk,
  type ToolContext,
} from '@nexgent/kernel'
import { matchGlob } from '../glob.js'
import type { Redactor } from '../redact.js'
import type { LocalSandbox, SandboxAssessment } from '../sandbox.js'

/** The approval fields a tool proposes; the loop adds `id`, `sessionId`, `callId`, `expiresAt`. */
export type PreflightApproval = Pick<ApprovalRequest, 'tool' | 'summary' | 'risk' | 'options'>
  & Partial<Pick<ApprovalRequest, 'detail' | 'pattern'>>

/** The answer of a {@link ToolPreflight}. */
export type ToolPreflightResult =
  | { readonly action: 'allow'; readonly grant?: ApprovalGrant }
  | { readonly action: 'ask'; readonly approval: PreflightApproval }
  | { readonly action: 'deny'; readonly error: ErrorInfo }

/** Policy pre-check for one call; never prompts and never mutates anything. */
export type ToolPreflight = (input: unknown, context: ToolContext, grants?: readonly ApprovalGrant[]) => Promise<ToolPreflightResult>

/** A kernel {@link Tool} with a {@link ToolPreflight}. */
export interface WorkspaceTool extends Tool {
  readonly preflight: ToolPreflight
}

/** The ask a tool raises through {@link ToolContext.requestApproval}. */
export type ApprovalAsk = ToolApprovalAsk

/** What every workspace tool needs. */
export interface ToolDeps {
  readonly sandbox: LocalSandbox
  readonly redactor: Redactor
}

/** One subject the call touches: a path or a command segment, with the pattern grants match against. */
export interface PolicySubject {
  /** Grant pattern style. */
  readonly kind: 'path' | 'command'
  /** For paths the project-relative path; for commands the matched segment text. */
  readonly value: string
}

/** Whether a stored grant admits a subject for a tool. */
export function grantAdmits(grant: ApprovalGrant, tool: string, subject: PolicySubject): boolean {
  if (grant.tool !== tool) return false
  if (grant.pattern === undefined) return true
  return subject.kind === 'command'
    ? subject.value.trim().startsWith(grant.pattern.trim())
    : matchGlob(grant.pattern, subject.value, process.platform === 'win32')
}

/** The sandbox for this call's mode. */
export function sandboxFor(deps: ToolDeps, context: ToolContext): LocalSandbox {
  return deps.sandbox.withMode(context.sandboxMode)
}

/** The `sandbox/denied` error for a denial (`SANDBOX_DENIED { mode, path | command }`). */
export function deniedError(assessment: Extract<SandboxAssessment, { kind: 'deny' }>, mode: string, command?: string): NexgentError {
  const subject = command === undefined ? `path ${assessment.path}` : `command ${JSON.stringify(command)} (cwd ${assessment.path})`
  return new NexgentError('sandbox/denied', `SANDBOX_DENIED: ${subject} — ${assessment.reason} [mode ${mode}, ${assessment.code}]`, {
    details: {
      mode,
      code: assessment.code,
      ...(command === undefined ? { path: assessment.path } : { command, cwd: assessment.path }),
    },
  })
}

/** `approval/denied` for an `ask` call that reached the handler without approval. */
export function approvalRequiredError(reason: string): NexgentError {
  return new NexgentError('approval/denied', `approval required and not granted: ${reason}`)
}

/**
 * Turn an assessment into a preflight answer. In `read-only` mode escalated
 * write / execute calls are denied without asking (`permissions.md` §工具审批).
 */
export function preflightFrom(
  assessment: SandboxAssessment,
  options: {
    readonly tool: string
    readonly mode: string
    readonly summary: string
    readonly detail?: string
    readonly subjects: readonly PolicySubject[]
    readonly grants?: readonly ApprovalGrant[]
    readonly command?: string
  },
): ToolPreflightResult {
  if (assessment.kind === 'allow') return { action: 'allow' }
  if (assessment.kind === 'deny') return { action: 'deny', error: toErrorInfo(deniedError(assessment, options.mode, options.command)) }
  const grantable = assessment.options.length > 1
  if (grantable && options.grants !== undefined && options.subjects.length > 0) {
    for (const grant of options.grants) {
      if (options.subjects.every(subject => grantAdmits(grant, options.tool, subject))) return { action: 'allow', grant }
    }
  }
  return {
    action: 'ask',
    approval: {
      tool: options.tool,
      summary: options.summary,
      detail: [options.detail, `rule: ${assessment.reason}`].filter(Boolean).join('\n'),
      risk: assessment.risk,
      options: assessment.options,
      ...(assessment.pattern === undefined ? {} : { pattern: assessment.pattern }),
    },
  }
}

/** How to present an escalated call when asking for approval. */
export interface AskPresentation {
  readonly summary: string
  readonly detail?: string
  /** Grant subject; for commands the matched segment, for paths the project-relative path. */
  readonly subject?: PolicySubject
}

/**
 * Enforce an assessment inside a handler (the second resolve): throw on
 * deny, obtain approval on ask (see module docs), and return the resolved
 * path the operation must use.
 */
export async function enforce(
  assessment: SandboxAssessment,
  context: ToolContext,
  presentation: AskPresentation,
  command?: string,
): Promise<string> {
  if (assessment.kind === 'deny') throw deniedError(assessment, context.sandboxMode, command)
  if (assessment.kind === 'allow') return assessment.path
  if (context.approved) return assessment.path
  {
    const detail = [presentation.detail, `rule: ${assessment.reason}`].filter(Boolean).join('\n')
    const allowed = await context.requestApproval({
      summary: presentation.summary,
      detail,
      risk: assessment.risk,
      options: assessment.options,
      ...(assessment.pattern === undefined ? {} : { pattern: assessment.pattern }),
      ...(presentation.subject === undefined ? {} : { subject: presentation.subject }),
    })
    if (allowed) return assessment.path
    throw new NexgentError('approval/denied', `not approved: ${presentation.summary} (${assessment.reason})`)
  }
}

/** Read a string field from an untrusted input object. */
export function stringField(input: unknown, name: string, required: true): string
export function stringField(input: unknown, name: string, required?: false): string | undefined
export function stringField(input: unknown, name: string, required = false): string | undefined {
  const value = (input as Record<string, unknown> | null)?.[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new NexgentError('tool/invalid-input', `"${name}" must be a string`)
  return value
}

/** Read an optional number field. */
export function numberField(input: unknown, name: string): number | undefined {
  const value = (input as Record<string, unknown> | null)?.[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new NexgentError('tool/invalid-input', `"${name}" must be a number`)
  return value
}

/** Read an optional boolean field. */
export function booleanField(input: unknown, name: string): boolean | undefined {
  const value = (input as Record<string, unknown> | null)?.[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new NexgentError('tool/invalid-input', `"${name}" must be a boolean`)
  return value
}

/** Ensure the input is an object. */
export function inputObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new NexgentError('tool/invalid-input', 'arguments must be an object')
  }
  return input as Record<string, unknown>
}

/** JSON schema helper for an object with required properties. */
export function objectSchema(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}

/** Run a preflight body, converting thrown errors into `deny`. */
export async function guardPreflight(body: () => Promise<ToolPreflightResult>): Promise<ToolPreflightResult> {
  try {
    return await body()
  } catch (error) {
    return { action: 'deny', error: toErrorInfo(error) }
  }
}
