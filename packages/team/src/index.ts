/**
 * `@nexgent/team` — the Lead and named teammates (child sessions), a
 * persistent mailbox and a shared task board, all recorded as `team.*`
 * records in the Lead session and rebuilt from them after a hard kill.
 * See README.md.
 */
export * from './state.js'
export * from './team.js'
export * from './tools.js'
export * from './registry.js'
export { apply, name, TeamPlugin } from './plugin.js'
