/**
 * `@nexgent/workspace` — the project directory and `.nexgent/` layout, the
 * sandbox (path and command policy), the process runner, and the file,
 * search and shell tools. See README.md.
 */
export * from './config.js'
export * from './workspace.js'
export * from './project-data.js'
export * from './paths.js'
export * from './glob.js'
export * from './gitignore.js'
export * from './command-policy.js'
export * from './sandbox.js'
export * from './env.js'
export * from './output.js'
export * from './redact.js'
export * from './process.js'
export * from './os-sandbox.js'
export * from './windows-job.js'
export * from './shell-check.js'
export * from './tools/common.js'
export * from './tools/fs.js'
export * from './tools/search.js'
export * from './tools/shell.js'
export { apply, createWorkspaceServices, createWorkspaceTools, name, WorkspacePlugin } from './services.js'
export type { Config, WorkspaceServices, WorkspaceServicesOptions } from './services.js'
