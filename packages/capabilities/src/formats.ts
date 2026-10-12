/**
 * The entry-file formats of each component kind, as the model sees them in
 * the `capability_draft` description and in `capability_try` errors. The
 * examples are minimal valid components (a test runs each through
 * `validateComponent`), so what the model copies loads on the first try.
 * Field rules follow the contract (`contracts/capabilities.ts`,
 * `collaboration.ts`); this file only words them.
 */
import { COMPONENT_ENTRY_FILES, type CapabilityComponentKind } from '@nexgent/kernel'

/** One minimal valid component per kind: its files, by component-relative path. */
export const COMPONENT_EXAMPLES: Readonly<Record<CapabilityComponentKind, { readonly name: string; readonly files: Readonly<Record<string, string>> }>> = {
  'function-module': {
    name: 'order-tools',
    files: {
      'functions.json': JSON.stringify({
        formatVersion: 1,
        name: 'order-tools',
        description: 'Helpers for the order CSV.',
        entry: 'index.mjs',
        functions: [{
          name: 'sumAmounts',
          description: 'Sum the amount column of an order CSV.',
          inputSchema: { type: 'object', properties: { csvText: { type: 'string' } }, required: ['csvText'] },
          effects: [],
        }],
      }),
      'index.mjs': 'export function sumAmounts(input) {\n  return input.csvText.trim().split(/\\r?\\n/).slice(1).reduce((sum, line) => sum + Number(line.split(\',\')[1]), 0)\n}\n',
    },
  },
  plugin: {
    name: 'greeter',
    files: {
      'plugin.json': JSON.stringify({ formatVersion: 1, name: 'greeter', description: 'Adds a greeting tool.', entry: 'index.mjs', permissions: 'Registers one tool; reads and writes nothing.', tools: ['say_hello'] }),
      'index.mjs': 'export default {\n  name: \'greeter\',\n  apply(ctx) {\n    ctx.tools.register({\n      definition: { name: \'say_hello\', description: \'Say hello.\', inputSchema: { type: \'object\' }, effects: [], approval: \'never\' },\n      handler: async () => ({ content: \'hello\' }),\n    })\n  },\n}\n',
    },
  },
  skill: {
    name: 'monthly-summary',
    files: { 'SKILL.md': '---\nname: monthly-summary\ndescription: Summarise one month of orders into JSON.\n---\n\n1. Read the CSV.\n2. Write the summary and run the check command.\n' },
  },
  'context-policy': {
    name: 'house-rules',
    files: { 'policy.json': JSON.stringify({ formatVersion: 1, name: 'house-rules', description: 'How this project wants work done.', instructions: 'Run the check command before presenting a file.' }) },
  },
  preset: {
    name: 'csv-checker',
    files: { 'preset.json': JSON.stringify({ formatVersion: 1, name: 'csv-checker', description: 'Checks CSV outputs without changing them.', sandboxMode: 'read-only' }) },
  },
  'team-template': {
    name: 'write-and-check',
    files: { 'team.json': JSON.stringify({ formatVersion: 1, name: 'write-and-check', description: 'One teammate writes, one checks.', members: [{ name: 'writer', task: 'Write the file.' }, { name: 'checker', task: 'Check the file.', preset: 'read-only-checker' }] }) },
  },
  architecture: {
    name: 'draft-then-check',
    files: { 'architecture.json': JSON.stringify({ format: 1, architecture: { nodes: [{ id: 'draft', prompt: 'Write the file.', dependencies: [] }, { id: 'check', prompt: 'Check the file.', dependencies: ['draft'] }] } }) },
  },
}

/** The rules of each kind's entry file, one paragraph each. */
const RULES: Readonly<Record<CapabilityComponentKind, string>> = {
  'function-module': 'functions.json is ONE object (not an array) with formatVersion 1, name (= the component name), description, optional entry (.mjs, default index.mjs) and functions: 1 to 16 entries, each with name (letters, digits, _; the exported function), description, inputSchema (a JSON Schema object) and effects (an array of "read", "write", "network"; [] when the function only computes). '
    + 'The entry module is one self-contained .mjs file (no imports of other files); each function receives (input, host), where host has the project file functions of run_code (writing ones only with "write" in effects). The tool name is cap_<module>_<function>.',
  plugin: 'plugin.json is one object with formatVersion 1, name (= the component name), description, permissions (what it will be able to do, shown to the user), optional entry (.mjs, default index.mjs) and tools (names it registers). The module exports a Cordis plugin { name, apply(ctx) }.',
  skill: 'SKILL.md starts with YAML front matter: name (= the component name) and description (one line), optional when_to_use; the instructions follow.',
  'context-policy': 'policy.json is one object with formatVersion 1, name (= the component name), description and any of instructions, personaSuffix, compaction { thresholdTokens 10000-1000000, keepRecentTurns 1-10 }; no other fields.',
  preset: 'preset.json is one object with formatVersion 1, name (= the component name), description and optional persona, tools { allow, deny }, sandboxMode, model.',
  'team-template': 'team.json is one object with formatVersion 1, name (= the component name), description and members: [{ name, task, optional preset, persona }].',
  architecture: 'architecture.json is { "format": 1, "architecture": { "nodes": [{ id, prompt, dependencies: [ids], optional preset, tools, model }] } }.',
}

/** The format of one kind's entry file with its minimal example, for the model. */
export function componentFormat(kind: CapabilityComponentKind): string {
  const example = COMPONENT_EXAMPLES[kind]
  const entry = COMPONENT_ENTRY_FILES[kind]
  return `${RULES[kind]} Minimal ${entry}: ${example.files[entry]}`
}
