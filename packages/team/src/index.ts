/**
 * `@nexgent/team` — team state as a session records it: the roster, a
 * persistent mailbox and a shared task board (`team.*` records), rebuilt by
 * pure functions. The model-facing teammate tools were removed (2026-10-20);
 * the mailbox and the board stay for the coordinator's threads. See README.md.
 */
export * from './state.js'
