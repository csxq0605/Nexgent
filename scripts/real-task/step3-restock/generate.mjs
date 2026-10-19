#!/usr/bin/env node
/**
 * Material of the step-3 real task (docs/plan/step-3-work-partition.md
 * §真实模型验收): `inventory.xlsx`, one sheet `Inputs` with six SKUs, two of
 * which need no restock. Columns: SKU, 名称, 现有库存, 周需求, 交期(周),
 * 安全库存, 单价. Rebuilt after organization-loop's Excel restock task
 * (archive/python-host docs/organization-loop.md), which committed no fixture.
 * Deterministic: running it again rewrites the same bytes.
 *
 * The hidden check (../step3-restock-hidden.mjs) imports SKUS from here and
 * computes the expected plan on its own.
 *
 * Usage: node scripts/real-task/step3-restock/generate.mjs   (writes next to itself)
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeWorkbook } from './xlsx.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Header of the Inputs sheet, in column order. */
export const HEADER = ['SKU', '名称', '现有库存', '周需求', '交期(周)', '安全库存', '单价']

/**
 * The six SKUs. Fractional weekly demand and lead times make the target stock
 * fractional, so rounding the order quantity up matters; P03 and P05 are
 * already above target. Within a SKU no input equals the target, order
 * quantity or amount of either round, so the hidden check cannot mistake a
 * copied input for a computed value.
 */
export const SKUS = [
  { sku: 'P01', name: '螺丝套装', onHand: 14, weeklyDemand: 12, leadWeeks: 2, safetyStock: 10, unitPrice: 2 },
  { sku: 'P02', name: '密封垫圈', onHand: 9, weeklyDemand: 7.5, leadWeeks: 3, safetyStock: 5, unitPrice: 4.5 },
  { sku: 'P03', name: '扎带', onHand: 60, weeklyDemand: 10, leadWeeks: 2, safetyStock: 8, unitPrice: 0.8 },
  { sku: 'P04', name: '轴承', onHand: 2, weeklyDemand: 4.2, leadWeeks: 2.5, safetyStock: 3, unitPrice: 12.5 },
  { sku: 'P05', name: '保险丝', onHand: 40, weeklyDemand: 6, leadWeeks: 4, safetyStock: 6, unitPrice: 1.5 },
  { sku: 'P06', name: '电缆接头', onHand: 20, weeklyDemand: 14.5, leadWeeks: 1.5, safetyStock: 12, unitPrice: 3.2 },
]

/** The feedback round's change: "P01 的现有库存应为 20，请更新。" */
export const FEEDBACK_OVERRIDE = { sku: 'P01', onHand: 20 }

/** The inventory.xlsx bytes. */
export function inventoryXlsx() {
  const rows = [HEADER, ...SKUS.map(s => [s.sku, s.name, s.onHand, s.weeklyDemand, s.leadWeeks, s.safetyStock, s.unitPrice])]
  return writeWorkbook([{ name: 'Inputs', rows }])
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(HERE, 'inventory.xlsx'), inventoryXlsx())
  process.stderr.write('step3-restock: wrote inventory.xlsx\n')
}
