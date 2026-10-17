/**
 * `@nexgent/tasking` — materials, deliverables (`present`, version
 * snapshots, diffs), per-turn file changes, feedback and the persistent
 * goal. Implements the `TaskingService` contract. See README.md.
 */
export * from './files-util.js'
export * from './diff.js'
export * from './project-paths.js'
export * from './materials.js'
export * from './deliverables.js'
export * from './gitignore.js'
export * from './project-walk.js'
export * from './turn-files.js'
export * from './feedback-goals.js'
export * from './present-tool.js'
export * from './todo-tool.js'
export * from './task-records.js'
export { apply, createTaskingService, name, TaskingPlugin } from './service.js'
export type { Config, LocalTaskingService, TaskingServiceOptions } from './service.js'
export * from './rewind.js'
