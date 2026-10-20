/**
 * `@nexgent/ptc` — programmatic tool calling, Node backend: a runtime that
 * runs model-written JavaScript in a new, isolated Node process and answers
 * its host function calls (`runProgram`), the project host functions
 * (files, checked against the caller's sandbox), and the
 * `run_code` tool. `@nexgent/workflow` runs its scripts on the same runtime.
 * See README.md.
 */
export * from './protocol.js'
export { BOOTSTRAP_SOURCE, HOST_GONE_EXIT } from './bootstrap.js'
export * from './runtime.js'
export * from './functions.js'
export * from './tool.js'
export { apply, name, PtcPlugin } from './plugin.js'
