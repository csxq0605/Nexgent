/**
 * The formats the model reads in `capability_draft`: every minimal example
 * passes the same checks `capability_try` runs, and a malformed entry file
 * is answered with every problem plus the expected format.
 */
import { CAPABILITY_COMPONENT_KINDS, COMPONENT_ENTRY_FILES, CAPABILITY_DRAFT_TOOL } from '@nexgent/kernel'
import { validateCapabilitySkill } from '@nexgent/skill'
import { validateCapabilityArchitecture } from '@nexgent/workflow'
import { describe, expect, it } from 'vitest'
import { capabilityDraftTool, COMPONENT_EXAMPLES, componentFormat, validateComponent, type ComponentValidator } from '../src/index.js'

const files = (record: Readonly<Record<string, string>>) => new Map(Object.entries(record).map(([path, text]) => [path, new Uint8Array(Buffer.from(text))]))
const validators = new Map<string, ComponentValidator>([
  ['skill', validateCapabilitySkill as ComponentValidator],
  ['architecture', validateCapabilityArchitecture as ComponentValidator],
]) as never

describe('component formats shown to the model', () => {
  it.each(CAPABILITY_COMPONENT_KINDS)('the %s example is a valid component and is quoted in the draft description', async kind => {
    const example = COMPONENT_EXAMPLES[kind]
    await expect(validateComponent({ kind, name: example.name }, files(example.files), '/example', validators)).resolves.toMatchObject({ kind })
    const description = capabilityDraftTool({} as never, async () => []).definition.description
    expect(description).toContain(example.files[COMPONENT_ENTRY_FILES[kind]]!)
    expect(description).toContain(componentFormat(kind))
  })

  it('the draft tool keeps the frozen name and schema', () => {
    const definition = capabilityDraftTool({} as never, async () => []).definition
    expect(definition.name).toBe(CAPABILITY_DRAFT_TOOL.name)
    expect(definition.inputSchema).toEqual(CAPABILITY_DRAFT_TOOL.inputSchema)
  })

  it('a malformed functions.json is answered with every problem and the expected format', async () => {
    const ref = { kind: 'function-module', name: 'orders-summary' } as const
    const bad = { 'functions.json': JSON.stringify({ description: 'x', functions: [{ name: 'summarize', description: 'd', effects: ['execute'] }] }), 'index.mjs': 'export function summarize() {}\n' }
    const error = await validateComponent(ref, files(bad), '/d', validators).then(() => undefined, (caught: Error) => caught)
    expect(error).toMatchObject({ code: 'tool/invalid-input' })
    for (const part of ['"formatVersion"', '"name"', '/functions/0 missing required property "inputSchema"', '/functions/0/effects/0', 'Expected: functions.json is ONE object', '"formatVersion":1']) {
      expect(error!.message).toContain(part)
    }
    const array = await validateComponent(ref, files({ ...bad, 'functions.json': '[]' }), '/d', validators).then(() => undefined, (caught: Error) => caught)
    expect(array!.message).toMatch(/expected "object", got array.*Expected: functions\.json is ONE object/)
  })
})
