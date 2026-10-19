/**
 * `@nexgent/subagent` — the `delegate` tool (one sub-task in a child
 * session, fresh or fork, in the foreground), the member runner the team and
 * workflow packages reuse, and recovery of runs a dead process left open.
 * See README.md.
 */
export * from './runner.js'
export * from './files.js'
export * from './delegate-tool.js'
export * from './recovery.js'
export { apply, name, SubagentPlugin } from './plugin.js'
