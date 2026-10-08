/**
 * `@nexgent/kernel` — the Nexgent runtime kernel: profile boot, the frozen
 * service contracts, `ctx.tools`, `ctx.approvals`, `ctx.credentials`,
 * `ctx.agents` and the agent loop, system-prompt assembly, and atomic-write
 * / JSON storage primitives.
 */
export { Context, Service, ValidationError } from '@deepseek-ai/cordis'
export type { Fiber, Plugin } from '@deepseek-ai/cordis'
export * from './contracts/index.js'
export { CONTRACT_SERVICES } from './services.js'
export type { ContractServiceName } from './services.js'

export { createApp, KERNEL_PLUGIN_NAMES, KERNEL_PLUGINS } from './app.js'
export type { CreateAppOptions, NexgentApp } from './app.js'
export {
  bootProfile,
  DEFAULT_PROFILE_FILE,
  defaultProfile,
  loadPatchFile,
  loadProfileFile,
  parsePatches,
  parseProfile,
  resolvePlugin,
} from './profile.js'
export type { LoadedRow, PluginRegistry } from './profile.js'

export { AgentsService } from './agents.js'
export type { AgentsConfig, CreateAgentOptions, ResumeAgentOptions } from './agents.js'
export { Agent, MODEL_IDLE_TIMEOUT, MODEL_TIMEOUT, repairHistory, TOOL_TIMEOUT, TurnAbort } from './agent.js'
export type {
  AgentSettings,
  CloseOptions,
  KernelToolContext,
  ProjectGrantWriter,
  RunOptions,
  TaskStats,
  ToolApprovalAsk,
  TurnResult,
} from './agent.js'
export { AgentEventHub } from './agent-events.js'
export type { AgentEvent, AgentEventListener, AgentEventType } from './agent-events.js'

export { TOOL_NAME_PATTERN, TOOL_SCOPE, ToolRegistryService } from './tools.js'
export type { ToolScope } from './tools.js'
export { ApprovalBrokerService } from './approvals.js'
export type { ApprovalsConfig } from './approvals.js'
export { approvalSubject, decideToolPolicy, derivePattern, globMatch, grantMatches } from './approval-policy.js'
export type { ApprovalSubject, ToolPolicyVerdict } from './approval-policy.js'
export {
  CREDENTIAL_FILE_NAME,
  credentialFilePath,
  CredentialsService,
  LocalCredentials,
  NEXGENT_HOME,
  nexgentHome,
  readCredentialFile,
  saveCredential,
} from './credentials.js'
export type { CredentialsConfig, CredentialSourceOptions } from './credentials.js'
export { appendProjectGrant, parseProjectConfig, readProjectConfig } from './project-config.js'
export type { LoadedProjectConfig } from './project-config.js'
export { DEFAULT_PERSONA, DEFAULT_PERSONA_SUFFIX, renderSystemPrompt } from './system-prompt.js'
export type { SystemPromptInput, SystemPromptTemplate } from './system-prompt.js'
export { validateJsonSchema } from './json-schema.js'
export { JsonStore, readJsonFile, writeJsonFile } from './storage/json-file.js'
export { fsyncDirectory, writeFileAtomic } from './util/atomic-write.js'
export type { WriteFileAtomicOptions } from './util/atomic-write.js'
export { abortPromise, deadline, MAX_TIMER_DELAY_MS, timeoutOf, TimeoutReason } from './util/timeout.js'
export type { Deadline } from './util/timeout.js'
