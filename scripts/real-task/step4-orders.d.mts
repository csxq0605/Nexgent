// Types for step4-orders.mjs (consumed by packages/test-support/tests/step4-fixtures.spec.ts).
export interface OrderRow {
  readonly orderId: string
  readonly date: string
  readonly region: string
  readonly product: string
  readonly quantity: number
  readonly unitPrice: number
  readonly discount: number
}
export interface MonthlySummary {
  readonly month: string | null
  readonly orders: number
  readonly units: number
  readonly revenue: number
  readonly byRegion: Readonly<Record<string, number>>
  readonly topProduct: string | null
}
export declare const COLUMNS: readonly string[]
export declare const REGIONS: readonly string[]
export declare const PRODUCTS: readonly { readonly name: string; readonly price: number }[]
export declare const MONTHS: { readonly history: readonly string[]; readonly taskA: string; readonly taskB: string }
export declare function ordersCsv(month: string): string
export declare function parseOrders(csvText: string): OrderRow[]
export declare function expectedSummary(csvText: string): MonthlySummary
export declare function expectedRegionsCsv(csvText: string): string
export declare function judgeSummary(csvText: string, summaryText: string): { readonly pass: boolean; readonly problems: readonly string[] }
