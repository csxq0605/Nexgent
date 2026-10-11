/** `@nexgent/cli` — the `nexgent` command; the exports serve tests and the acceptance script. */
export { main, processIo, packageVersion, exitCodeForError, errorMessage } from './main.js'
export type { CliIo, CliDeps } from './main.js'
export { COMMANDS, RESUME_DEFAULT_TASK, commandUsage, isSessionId, parseCliArgs, usage } from './args.js'
export type { AppInvocation, Command, HelpInvocation, Invocation, ResumeInvocation, RunInvocation, VersionInvocation } from './args.js'
export { CliError, EXIT } from './exit-codes.js'
export type { ExitCode } from './exit-codes.js'
export { initProjectLayout } from './layout.js'
export type { ProjectLayoutResult } from './layout.js'
export { credentialFilePath, describeApiKey, missingKeyMessage, NEXGENT_HOME_ENV, requireApiKey } from './credentials.js'
export type { CredentialProbe } from './credentials.js'
export type * from './events.js'
export { createRenderer, formatUsage, preview } from './render.js'
export type { Renderer, RenderMode, RunSummary, TextSink } from './render.js'
export { boundJsonLine } from './json-lines.js'
export {
  approvalChoices,
  createApprovalResponder,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  formatApprovalPrompt,
  headlessDecision,
  parseApprovalAnswer,
} from './approval.js'
export type { AnswerSource, ApprovalAnswer, ApprovalResponderOptions } from './approval.js'
export { InterruptController, installSignalHandlers, nextInterruptAction, signalExitCode } from './signals.js'
export type { HandledSignal, InterruptAction, InterruptPhase, SignalSource } from './signals.js'
export { exitCodeFor, TaskTally, taskStatus } from './outcome.js'
export type { TaskOutcomeInput } from './outcome.js'
export { loadRuntime, RUNTIME_NOT_WIRED_CODE, RUNTIME_NOT_WIRED_MESSAGE } from './runtime.js'
export type { CliRuntime, RuntimeOpenOptions, RuntimeSession } from './runtime.js'
