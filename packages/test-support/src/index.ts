/**
 * `@nexgent/test-support` — helpers shared by Nexgent test suites and the
 * step acceptance scripts: a scripted in-process `LLMProvider`, a scripted
 * OpenAI-compatible model server, fault injection, and the cross-process
 * acceptance harness. The README is the reference ("仿真规范").
 */
export {
  type ResolvedToolCall,
  type ScriptEntry,
  type ScriptedFault,
  type ScriptedFaultShorthand,
  type ScriptedToolCall,
  type ScriptedTurn,
  type ScriptedUsage,
  normalizeFault,
  splitText,
} from './script.js'
export {
  type ScriptedProvider,
  type ScriptedProviderCall,
  type ScriptedProviderOptions,
  scriptedProvider,
  toContractUsage,
} from './provider.js'
export {
  type ChatCompletionBody,
  type ChatWireMessage,
  type ModelRequestOutcome,
  type RecordedModelRequest,
  type ScriptedModelServer,
  type ScriptedModelServerOptions,
  scriptedModelServer,
  toWireUsage,
} from './server.js'
export * from './acceptance.js'
