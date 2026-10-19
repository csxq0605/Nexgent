import type { BundleComponentInput } from '../src/index.js'

const FUNCTIONS = JSON.stringify({
  formatVersion: 1,
  name: 'order-tools',
  description: 'Order helpers.',
  functions: [{ name: 'total', description: 'Sum amounts.', inputSchema: { type: 'object' }, effects: [] }],
})

/** A small bundle with a skill and a function module; `variant` changes one byte of content. */
export function sampleComponents(variant = 'a'): BundleComponentInput[] {
  return [
    {
      kind: 'skill',
      name: 'summarize-orders',
      files: [
        { path: 'SKILL.md', content: `---\nname: summarize-orders\ndescription: Sum orders by region (${variant}).\n---\n\n1. Read the CSV.\n` },
        { path: 'reference/columns.md', content: 'region, amount\n' },
      ],
    },
    {
      kind: 'function-module',
      name: 'order-tools',
      files: [
        { path: 'functions.json', content: FUNCTIONS },
        { path: 'index.mjs', content: new Uint8Array(Buffer.from('export function total(input) { return input.rows.reduce((a, r) => a + r.amount, 0) }\n')) },
      ],
    },
  ]
}
