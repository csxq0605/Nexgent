// Types for generate.mjs (consumed by packages/test-support/tests/step3-restock.spec.ts).
export interface Sku { readonly sku: string; readonly name: string; readonly onHand: number; readonly weeklyDemand: number; readonly leadWeeks: number; readonly safetyStock: number; readonly unitPrice: number }
export declare const HEADER: readonly string[]
export declare const SKUS: readonly Sku[]
export declare const FEEDBACK_OVERRIDE: { readonly sku: string; readonly onHand: number }
export declare function inventoryXlsx(): Buffer
