/**
 * `@nexgent/context` — per-turn context for the agent loop: the workspace
 * instructions file, attached-material references, and basic compaction of
 * long histories. Implements `ContextProvider`, `Compactor` and
 * `ContextService` (`packages/kernel/src/contracts/context.ts`). See README.md.
 */
export * from './text.js'
export * from './instructions.js'
export * from './materials.js'
export * from './compaction.js'
export * from './service.js'
export { apply, checkContextPluginConfig, ContextPlugin, createContextService, name } from './plugin.js'
export type { ContextPluginConfig } from './plugin.js'
