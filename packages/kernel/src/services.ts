/**
 * Context property names of the step-1 contract services.
 *
 * Every runtime package registers its implementation with
 * `ctx.set('<name>', impl)` (or a `Service` subclass of the same name) from
 * its Cordis plugin, and consumers reach it as `ctx.<name>` typed by the
 * contract only. `ctx.agents` is declared next to its implementation.
 */
import type { ApprovalBroker } from './contracts/approvals.js'
import type { Credentials } from './contracts/credentials.js'
import type { Ledger } from './contracts/ledger.js'
import type { LLMProvider } from './contracts/llm.js'
import type { SessionStore } from './contracts/session.js'
import type { ToolRegistry } from './contracts/tools.js'
import type { ProcessRunner, Sandbox, Workspace } from './contracts/workspace.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `@nexgent/llm`: the model route. */
    llm: LLMProvider
    /** `@nexgent/session`: the request/tool/task ledger. */
    ledger: Ledger
    /** `@nexgent/session`: session JSONL persistence. */
    session: SessionStore
    /** `@nexgent/workspace`: the project directory and `.nexgent/` layout. */
    workspace: Workspace
    /** `@nexgent/workspace`: path and command policy. */
    sandbox: Sandbox
    /** `@nexgent/workspace`: child-process lifecycle. */
    processes: ProcessRunner
    /** `@nexgent/kernel`: API-key resolution. */
    credentials: Credentials
    /** `@nexgent/kernel`: tool registry. */
    tools: ToolRegistry
    /** `@nexgent/kernel`: the approval broker. */
    approvals: ApprovalBroker
  }
}

/** The contract service names, in boot order. */
export const CONTRACT_SERVICES = [
  'credentials',
  'workspace',
  'sandbox',
  'processes',
  'ledger',
  'session',
  'llm',
  'tools',
  'approvals',
] as const

/** One of {@link CONTRACT_SERVICES}. */
export type ContractServiceName = (typeof CONTRACT_SERVICES)[number]
