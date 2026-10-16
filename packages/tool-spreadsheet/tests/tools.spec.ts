import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, STEP3_MIGRATED_TOOLS, type Context, type NexgentApp, type Plugin, type SessionRecord } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { readDocumentTool, SkillPlugin } from '@nexgent/skill'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { readSpreadsheetTool, SpreadsheetPlugin, writeSpreadsheetTool } from '../src/index.js'
import { rawXlsx, setup, tempDir } from './helpers.js'

/** The Excel restock task (step 3, organization-loop): inventory inputs → plan with cross-sheet formulas → summary. */
function restock(stockP01 = 14) {
  const inputs = [
    ['SKU', 'Stock', 'WeeklyDemand', 'LeadWeeks', 'SafetyStock', 'UnitPrice'],
    ['P01', stockP01, 10, 2, 5, 3.5],
    ['P02', 40, 12, 3, 6, 2.25],
    ['P03', 0, 7, 1, 2, 10],
    ['P04', 100, 5, 2, 3, 1.1],
    ['P05', 9, 9, 4, 4, 0.3],
    ['P06', 30, 20, 1, 10, 7.77],
  ]
  const plan: (string | number)[][] = [['SKU', 'Target', 'Order', 'Amount']]
  for (let r = 2; r <= 7; r++) {
    plan.push([`=Inputs!A${r}`, `=Inputs!C${r}*Inputs!D${r}+Inputs!E${r}`, `=MAX(0,ROUNDUP(B${r}-Inputs!B${r},0))`, `=ROUND(C${r}*Inputs!F${r},2)`])
  }
  return [
    { name: 'Inputs', rows: inputs },
    { name: 'Plan', rows: plan },
    { name: 'Summary', rows: [['Metric', 'Value'], ['Units to order', '=SUM(Plan!C2:C7)'], ['Order amount', '=SUM(Plan!D2:D7)'], ['SKUs to order', '=COUNTIF(Plan!C2:C7,">0")']] },
  ]
}

describe('write_spreadsheet and read_spreadsheet', () => {
  it('match the frozen contract (name, effects, approval)', async () => {
    const { services } = await setup('workspace-write')
    for (const { definition } of [readSpreadsheetTool(services.sandbox), writeSpreadsheetTool(services.sandbox)]) {
      expect(STEP3_MIGRATED_TOOLS).toContainEqual({ name: definition.name, effects: definition.effects, approval: definition.approval })
    }
  })

  it('writes the restock workbook, reads it back with formulas, and replaces it after feedback only with overwrite', async () => {
    const { root, services, context } = await setup()
    const write = writeSpreadsheetTool(services.sandbox)
    const read = readSpreadsheetTool(services.sandbox)
    const first = await write.handler({ path: 'out/purchase.xlsx', sheets: restock() }, context())
    expect(first.content).toContain('Created out/purchase.xlsx')
    expect(first.content).toContain('Summary!B2 = 53')
    expect(first.content).toContain('Summary!B3 = 142.3')
    expect(first.meta).toMatchObject({ path: 'out/purchase.xlsx', created: true })

    const summary = await read.handler({ path: 'out/purchase.xlsx', sheet: 'summary' }, context())
    expect(summary.content).toBe([
      'Workbook out/purchase.xlsx: sheets Inputs (A1:F7), Plan (A1:D7), Summary (A1:B4)',
      '## Sheet Summary, range A1:B4',
      'row,A,B',
      '1,Metric,Value',
      '2,Units to order,53',
      '3,Order amount,142.3',
      '4,SKUs to order,4',
      '',
      'Formulas:',
      'B2: =SUM(Plan!C2:C7) → 53',
      'B3: =SUM(Plan!D2:D7) → 142.3',
      'B4: =COUNTIF(Plan!C2:C7,">0") → 4',
    ].join('\n'))
    const plan = await read.handler({ path: 'out/purchase.xlsx', sheet: 'Plan', range: 'B2:C3' }, context())
    expect(plan.content).toContain('row,B,C\n2,25,11\n3,42,2')
    expect(plan.meta).toMatchObject({ sheet: 'Plan', range: 'B2:C3', formulas: 4, notRecalculated: 0, changedFromSaved: 0 })

    // read_document (cached values only) agrees with the calculator.
    const document = await readDocumentTool(services.sandbox).handler({ path: 'out/purchase.xlsx', sheet: 'Summary' }, context())
    expect(document.content).toContain('Units to order,53')

    // Feedback: P01 stock 14 → 20. Replacing needs overwrite.
    const before = await readFile(join(root, 'out/purchase.xlsx'))
    await expect(write.handler({ path: 'out/purchase.xlsx', sheets: restock(20) }, context())).rejects.toMatchObject({
      code: 'tool/failed', message: expect.stringContaining('already exists; pass overwrite: true'),
    })
    expect(await readFile(join(root, 'out/purchase.xlsx'))).toEqual(before)
    const second = await write.handler({ path: 'out/purchase.xlsx', sheets: restock(20), overwrite: true }, context())
    expect(second.content).toContain('Replaced out/purchase.xlsx')
    expect(second.content).toContain('Summary!B2 = 47')
    expect(second.content).toContain('Plan!C2 = 5')
  })

  it('recalculates a workbook saved by LibreOffice to the values it saved (dates shown as ISO text)', async () => {
    const { root, services, context } = await setup('read-only')
    await writeFile(join(root, 'orders.xlsx'), await readFile(new URL('../../skill/tests/fixtures/orders.xlsx', import.meta.url)))
    const read = readSpreadsheetTool(services.sandbox)
    const orders = await read.handler({ path: 'orders.xlsx' }, context())
    expect(orders.content).toContain('1,id,customer,qty,price,date,total,,TRUE\n2,1,"Acme, Inc.",3,9.5,2026-10-01,28.5,,\n3,2,张三,5,2.25,2026-10-02,11.25,,')
    expect(orders.content).toContain('F2: =C2*D2 → 28.5')
    expect(orders.meta).toMatchObject({ formulas: 4, notRecalculated: 0, changedFromSaved: 0 })
    expect((await read.handler({ path: 'orders.xlsx', sheet: 'Summary' }, context())).content).toContain('C2: =SUM(Orders!F2:F4) → 139.75')
  })

  it('refuses a formula that cannot be calculated and writes nothing', async () => {
    const { root, services, context } = await setup()
    const write = writeSpreadsheetTool(services.sandbox)
    for (const formula of ['=1/0', '=Missing!A1', '=B2', "='[outside.xlsx]Data'!A1", '=UNKNOWNFUNCTION(A1)']) {
      await expect(write.handler({ path: 'bad.xlsx', sheets: [{ name: 'Data', rows: [['Input', 'Result'], [2, formula]] }] }, context()))
        .rejects.toMatchObject({ code: 'tool/failed', message: expect.stringMatching(/^nothing was written: Data!B2 /), details: { reason: 'formula', cell: 'Data!B2' } })
    }
    await expect(stat(join(root, 'bad.xlsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(write.handler({ path: 'bad.csv', sheets: [{ name: 'Data', rows: [[1]] }] }, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(write.handler({ path: 'bad.xlsx', sheets: [{ name: 'a:b', rows: [[1]] }] }, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('follows the sandbox: read-only mode reads but cannot write; host directories are denied and paths outside the project ask', async () => {
    const { root, services, context } = await setup('read-only')
    const write = writeSpreadsheetTool(services.sandbox)
    const read = readSpreadsheetTool(services.sandbox)
    const material = join(root, '.nexgent', 'materials', 'm1')
    await mkdir(material, { recursive: true })
    await writeFile(join(material, 'inventory.xlsx'), rawXlsx({ Inputs: '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*3</f><v>6</v></c></row>' }))
    const output = await read.handler({ path: '.nexgent/materials/m1/inventory.xlsx' }, context())
    expect(output.content).toContain('1,2,6')

    await expect(write.handler({ path: 'x.xlsx', sheets: [{ name: 'S', rows: [[1]] }] }, context())).rejects.toMatchObject({ code: 'sandbox/denied' })
    const writable = { mode: 'workspace-write' as const }
    await expect(write.handler({ path: '.nexgent/outputs/x.xlsx', sheets: [{ name: 'S', rows: [[1]] }] }, context(writable))).rejects.toMatchObject({ code: 'sandbox/denied' })
    await expect(write.handler({ path: '.nexgent/materials/m1/inventory.xlsx', sheets: [{ name: 'S', rows: [[1]] }], overwrite: true }, context(writable))).rejects.toMatchObject({ code: 'sandbox/denied' })
    const outside = await tempDir()
    // ADR 0022 decision 2: outside the project asks; nobody answers here.
    await expect(write.handler({ path: join(outside, 'x.xlsx'), sheets: [{ name: 'S', rows: [[1]] }] }, context(writable))).rejects.toMatchObject({ code: 'approval/denied' })
    await writeFile(join(outside, 'y.xlsx'), rawXlsx({ S: '' }))
    await expect(read.handler({ path: join(outside, 'y.xlsx') }, context())).rejects.toMatchObject({ code: 'approval/denied' })
    await expect(read.handler({ path: '.nexgent/sessions/x.xlsx' }, context())).rejects.toMatchObject({ code: 'sandbox/denied' })
  })

  it('reports what it cannot recalculate, pages large sheets and explains bad input', async () => {
    const { root, services, context } = await setup()
    const read = readSpreadsheetTool(services.sandbox)
    await writeFile(join(root, 'mixed.xlsx'), rawXlsx({
      Data: '<row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>TEXT(A1,"0")</f><v>4</v></c><c r="C1"><f>A1*2</f><v>8</v></c></row>',
      Other: '',
    }))
    const mixed = await read.handler({ path: 'mixed.xlsx' }, context())
    expect(mixed.content).toContain('Workbook mixed.xlsx: sheets Data (A1:C1), Other (empty)')
    expect(mixed.content).toContain('1,5,4,10')
    expect(mixed.content).toContain('Not recalculated (the value saved in the file is shown):\nData!B1: function TEXT is not supported')
    expect(mixed.content).toContain('1 formula value(s) differ from the values saved in the file')
    expect(mixed.meta).toMatchObject({ notRecalculated: 1, changedFromSaved: 1 })
    expect((await read.handler({ path: 'mixed.xlsx', sheet: 'Other' }, context())).content).toContain('## Sheet Other: empty')

    const rows = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="B${i + 1}"><v>1</v></c></row>`).join('')
    await writeFile(join(root, 'big.xlsx'), rawXlsx({ Big: rows }))
    const big = await read.handler({ path: 'big.xlsx' }, context())
    expect(big.content).toContain('range A1:B2500 (cut from A1:B3000; pass range to read the rest)')
    expect(big.meta).toMatchObject({ truncated: true })
    expect((await read.handler({ path: 'big.xlsx', range: 'A2990:B3000' }, context())).content).toContain('3000,2999,1')

    await expect(read.handler({ path: 'big.xlsx', range: 'A1:Z1000' }, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(read.handler({ path: 'big.xlsx', range: 'nonsense' }, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(read.handler({ path: 'big.xlsx', sheet: 'Nope' }, context())).rejects.toMatchObject({ code: 'tool/invalid-input', message: expect.stringContaining('"Big"') })
    await expect(read.handler({ path: 'data.csv' }, context())).rejects.toMatchObject({ code: 'tool/invalid-input', message: expect.stringContaining('read_file') })
    await writeFile(join(root, 'broken.xlsx'), 'not a zip')
    await expect(read.handler({ path: 'broken.xlsx' }, context())).rejects.toMatchObject({ code: 'tool/failed', message: expect.stringContaining('broken.xlsx: not a valid .xlsx file') })
    await expect(read.handler({ path: 'missing.xlsx' }, context())).rejects.toMatchObject({ code: 'tool/failed' })
  })
})

describe('in the agent loop (scripted model)', () => {
  let app: NexgentApp | undefined
  afterEach(async () => {
    await app?.dispose()
    app = undefined
  })

  async function boot(root: string, llm: ReturnType<typeof scriptedProvider>): Promise<NexgentApp> {
    return createApp({
      registry: {
        '@nexgent/workspace': WorkspacePlugin as Plugin,
        '@nexgent/session': SessionPlugin as Plugin,
        '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
        [SkillPlugin.name]: SkillPlugin as Plugin,
        [SpreadsheetPlugin.name]: SpreadsheetPlugin as Plugin,
      },
      patches: [
        { id: 'workspace', config: { root } },
        { insert: [{ id: 'skill', name: SkillPlugin.name }, { id: 'tool-spreadsheet', name: SpreadsheetPlugin.name }] },
      ],
    })
  }

  it('the tools are hidden until the spreadsheets skill is loaded; then a write and a read run as tool calls and land in the session', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    app = await boot(root, llm)
    llm.push(
      { toolCalls: [{ name: 'load_skill', arguments: { name: 'spreadsheets' } }] },
      { toolCalls: [{ name: 'write_spreadsheet', arguments: { path: 'purchase.xlsx', sheets: restock() } }] },
      { toolCalls: [{ name: 'read_spreadsheet', arguments: { path: 'purchase.xlsx', sheet: 'Summary' } }] },
      { content: 'Order 53 units for 142.3.' },
    )
    const agent = await app.agents.create({})
    const result = await agent.run({ text: 'Plan the restock.' })
    expect(result.reason).toEqual({ kind: 'completed' })
    llm.assertConsumed()
    const names = (index: number) => llm.requests[index]!.tools?.map(tool => tool.name) ?? []
    expect(names(0)).toContain('load_skill')
    expect(names(0)).not.toContain('read_spreadsheet')
    expect(names(0)).not.toContain('write_spreadsheet')
    expect(names(1)).toEqual(expect.arrayContaining(['read_spreadsheet', 'write_spreadsheet']))
    const loaded = llm.requests[1]!.messages.find(message => message.role === 'tool')
    expect(loaded?.content).toContain('Tools now available: read_spreadsheet, write_spreadsheet.')
    const results = llm.requests[3]!.messages.filter(message => message.role === 'tool')
    expect(results.map(message => [message.name, message.isError])).toEqual([['load_skill', false], ['write_spreadsheet', false], ['read_spreadsheet', false]])
    expect(results[2]!.content).toContain('2,Units to order,53')
    const log = (await readFile(join(app.ctx.workspace.layout.sessions, result.sessionId, 'session.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionRecord)
    expect(log.filter(record => record.type === 'tool.result')).toHaveLength(3)
  })
})
