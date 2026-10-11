import { PRESENT_TOOL, type ToolRecordInput } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { presentTool, renderPresentResult } from '../src/index.js'
import { project, SESSION_A, toolContext } from './helpers.js'

describe('present tool', () => {
  it('keeps the frozen name, schema, effects and approval', async () => {
    const p = await project()
    const tool = presentTool(p.tasking.deliverables)
    expect(tool.definition).toMatchObject({ name: 'present', inputSchema: PRESENT_TOOL.inputSchema, effects: ['read'], approval: 'never' })
    expect(tool.definition.description).toContain('deliverableId')
  })

  it('snapshots, appends deliverable.presented with this call’s turn / step / id, and tells the model the id', async () => {
    const p = await project()
    await p.write('out.md', '# out\n')
    const appended: ToolRecordInput[] = []
    const tool = presentTool(p.tasking.deliverables)
    const context = toolContext(p.workspace, { sessionId: SESSION_A, turn: 3, step: 2, callId: 'call_9', appendRecord: async record => void appended.push(record) })
    const result = await tool.handler({ paths: ['out.md'], summary: 'The report.' }, context)
    const [version] = (await p.tasking.deliverables.list())[0]!.versions
    expect(version).toMatchObject({ sessionId: SESSION_A, turn: 3, toolCallId: 'call_9', version: 1 })
    expect(appended).toEqual([{
      type: 'deliverable.presented', turn: 3, step: 2, toolCallId: 'call_9',
      deliverable: { deliverableId: version!.deliverableId, version: 1, title: 'out.md', summary: 'The report.', files: version!.files },
    }])
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe(renderPresentResult(version!))
    expect(result.content).toContain(`deliverableId "${version!.deliverableId}"`)
    expect(result.meta).toMatchObject({ deliverableId: version!.deliverableId, version: 1 })
  })

  it('works without appendRecord (a host that keeps no records) and in read-only mode', async () => {
    const p = await project()
    await p.write('out.md', '# out\n')
    const result = await presentTool(p.tasking.deliverables).handler({ paths: ['out.md'], summary: 's' }, toolContext(p.workspace, {}, 'read-only'))
    expect(result.content).toMatch(/^Presented deliverable /)
  })

  it('fails before snapshotting when the host records but passes no step', async () => {
    const p = await project()
    await p.write('out.md', '# out\n')
    const tool = presentTool(p.tasking.deliverables)
    await expect(tool.handler({ paths: ['out.md'], summary: 's' }, toolContext(p.workspace, { appendRecord: async () => undefined }))).rejects.toMatchObject({ code: 'tool/failed' })
    expect(await p.tasking.deliverables.list()).toEqual([])
  })

  it('surfaces a failed append as the tool failure, leaving the unreferenced snapshot listed by its metadata', async () => {
    const p = await project()
    await p.write('out.md', '# out\n')
    const tool = presentTool(p.tasking.deliverables)
    await expect(tool.handler({ paths: ['out.md'], summary: 's' }, toolContext(p.workspace, { step: 1, appendRecord: async () => { throw new Error('disk full') } }))).rejects.toThrow('disk full')
    expect(await p.tasking.deliverables.list()).toHaveLength(1)
  })
})
