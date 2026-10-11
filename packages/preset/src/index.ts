/**
 * `@nexgent/preset` — member presets: the three built-ins and the project's
 * `.nexgent/presets/*.json`, checked against the frozen `PresetFile`
 * contract. Used by `@nexgent/subagent` (delegate), and by the team and
 * workflow packages. See README.md.
 */
export * from './builtin.js'
export * from './registry.js'
