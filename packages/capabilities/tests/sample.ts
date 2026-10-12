import type { BundleComponentInput } from '../src/index.js'

/** A small bundle with a skill and a function module; `variant` changes one byte of content. */
export function sampleComponents(variant = 'a'): BundleComponentInput[] {
  return [
    {
      type: 'skill',
      name: 'summarize-orders',
      files: [
        { path: 'SKILL.md', content: `---\nname: summarize-orders\ndescription: Sum orders by region (${variant}).\n---\n\n1. Read the CSV.\n` },
        { path: 'reference/columns.md', content: 'region, amount\n' },
      ],
    },
    {
      type: 'function-module',
      name: 'order-tools',
      files: [{ path: 'index.mjs', content: new Uint8Array(Buffer.from('export function total(rows) { return rows.reduce((a, r) => a + r.amount, 0) }\n')) }],
    },
  ]
}
