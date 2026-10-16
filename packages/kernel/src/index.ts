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
export { Agent, CHECKS_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_CONTINUATIONS, DEFAULT_MAX_STEPS, OUTPUT_CUT_NOTE, OUTPUT_CUT_TOOL_RESULT, OUTPUT_CUT_TOOLS_NOTE, providerToolUses, stepLimitNote, FILES_END_CANCEL_MS, HOST_RECORD_TYPES, MODEL_IDLE_TIMEOUT, MODEL_TIMEOUT, repairHistory, TOOL_RECORD_TYPES, TOOL_TIMEOUT, TurnAbort } from './agent.js'
export type {
  AgentSettings,
  CloseOptions,
  KernelToolContext,
  ProjectGrantWriter,
  RunOptions,
  StepInjectionInput,
  StepInjector,
  TaskStats,
  ToolApprovalAsk,
  TurnInput,
  TurnResult,
} from './agent.js'
export { AgentEventHub } from './agent-events.js'
export type { AgentEvent, AgentEventListener, AgentEventType } from './agent-events.js'

export { FUNCTION_TOOL_NAME_PATTERN, isValidToolName, TOOL_NAME_PATTERN, TOOL_SCOPE, ToolRegistryService } from './tools.js'
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
export { appendGrant, appendProjectGrant, parseProjectConfig, readProjectConfig, readProjectGrants, readProjectSettings } from './project-config.js'
export { defaultProjectId, hasOldProjectData, layoutOf, layoutOfDataDir, locateProjectData, readProjectIdentitySync, resolveDataPath, resolveProjectLayout } from './project-data.js'
export type { ProjectDataOptions, ProjectDataPlace } from './project-data.js'
export type { LoadedProjectConfig } from './project-config.js'
export { DEFAULT_PERSONA, DEFAULT_PERSONA_SUFFIX, renderSystemPrompt } from './system-prompt.js'
export type { SystemPromptInput, SystemPromptTemplate } from './system-prompt.js'
export { validateJsonSchema } from './json-schema.js'
export { JsonStore, readJsonFile, writeJsonFile } from './storage/json-file.js'
export { fsyncDirectory, writeFileAtomic } from './util/atomic-write.js'
export type { WriteFileAtomicOptions } from './util/atomic-write.js'
export { readLedgerSlice, readSessionSlice, sliceBytes, sliceSessionRecords, sumLedgerCost } from './improvement-reads.js'
export type { LedgerCost, LedgerCostQuery, LedgerSliceQuery, RecordSlice, SessionSliceQuery } from './improvement-reads.js'
export { abortPromise, deadline, MAX_TIMER_DELAY_MS, timeoutOf, TimeoutReason } from './util/timeout.js'
export type { Deadline } from './util/timeout.js'
export type {
  AttachedComponent,
  CapabilityAttachInput,
  CapabilityAttachment,
  CapabilityHost,
  CapabilityVerification,
  CheckFailureSignal,
  ComponentCallInput,
  ComponentUseRef,
  ImprovementRun,
  ImprovementSignals,
  TaskBeginInput,
  TaskEndInput,
  TaskEndResult,
  TaskRecorder,
} from './capability-hooks.js'
