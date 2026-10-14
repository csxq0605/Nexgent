import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeBundle, writeCandidate, type BundleComponentInput } from '../src/index.js'
import { sampleComponents, tempDir } from './helpers.js'

const policy = (name: string, instructions: string): BundleComponentInput => ({
  kind: 'context-policy',
  name,
  files: [{ path: 'policy.json', content: JSON.stringify({ formatVersion: 1, name, description: `${name} policy`, instructions }) }],
})

describe('writeCandidate: the candidate bundle', () => {
  it('a proposed context policy replaces the base\'s, whatever its name (a bundle holds at most one)', async () => {
    const capabilities = join(await tempDir(), '.nexgent', 'capabilities')
    const base = await writeBundle(capabilities, [...sampleComponents(), policy('module-test-convention', 'Add tests for changed modules.')])
    const replacement = policy('per-module-tests', 'Every changed or added module gets test/<module>.test.js with cases; check before presenting.')
    const { record, bundle } = await writeCandidate(capabilities, {
      sessionId: 'prop-1',
      taskId: 'task-1',
      turn: 1,
      base,
      components: [{ kind: 'context-policy', name: 'per-module-tests', files: new Map(replacement.files.map(file => [file.path, Buffer.from(file.content as string)])) }],
      proofs: [{ kind: 'context-policy', name: 'per-module-tests', turn: 1, toolCallId: 'call-1' }],
    })
    expect(bundle.manifest.components.map(component => `${component.kind}/${component.name}`).sort())
      .toEqual(['context-policy/per-module-tests', 'function-module/order-tools', 'skill/summarize-orders'].sort())
    expect(record.components.map(component => component.name)).toEqual(['per-module-tests'])
  })

  it('other components of the base are kept unless one of the same kind and name is proposed', async () => {
    const capabilities = join(await tempDir(), '.nexgent', 'capabilities')
    const base = await writeBundle(capabilities, [...sampleComponents(), policy('module-test-convention', 'Add tests for changed modules.')])
    const skill = sampleComponents('b').find(component => component.kind === 'skill')!
    const { bundle } = await writeCandidate(capabilities, {
      sessionId: 'prop-2',
      taskId: 'task-2',
      turn: 1,
      base,
      components: [{ kind: 'skill', name: skill.name, files: new Map(skill.files.map(file => [file.path, Buffer.from(file.content as string)])) }],
      proofs: [{ kind: 'skill', name: skill.name, turn: 1, toolCallId: 'call-1' }],
    })
    expect(bundle.manifest.components.map(component => `${component.kind}/${component.name}`).sort())
      .toEqual(['context-policy/module-test-convention', 'function-module/order-tools', 'skill/summarize-orders'].sort())
    expect(bundle.version).not.toBe(base.version)
  })
})
