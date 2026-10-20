/**
 * `@nexgent/workflow` — the `workflow` tool: a model-written script
 * (`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`) or a
 * declarative graph runs its members in the foreground, in a PTC program
 * process (`@nexgent/ptc`), with the concurrency and member bounds enforced
 * by the host and `workflow.*` / `subagent.*` records in the parent session;
 * the graph compiler and content-addressed graph store; recovery of
 * interrupted workflows; the plugin. Members run through a
 * `WorkflowMemberRunner` (`@nexgent/subagent`'s `runMember` over `ctx.agents`). See README.md.
 */
export * from './architecture.js'
export * from './architecture-store.js'
export * from './capability-architecture.js'
export * from './runner.js'
export * from './runtime.js'
export * from './recovery.js'
export * from './tool.js'
export * from './organize.js'
export * from './profile.js'
export { apply, name, WorkflowPlugin } from './plugin.js'
