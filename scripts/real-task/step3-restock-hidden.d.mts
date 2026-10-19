// Types for step3-restock-hidden.mjs (consumed by packages/test-support/tests/step3-restock.spec.ts).
export interface PlanRow { readonly sku: string; readonly onHand: number; readonly target: number; readonly reorder: number; readonly amount: number }
export interface Plan { readonly rows: readonly PlanRow[]; readonly totals: { readonly units: number; readonly amount: number } }
export interface PurchaseCheck { readonly pass: boolean; readonly problems: string[]; readonly found: Record<string, unknown> }
export declare const PURCHASE_PATH: string
export declare function expectedPlan(override?: { readonly sku: string; readonly onHand: number }): Plan
export declare const EXPECTED: { readonly v1: Plan; readonly v2: Plan }
export declare function checkPurchase(bytes: Uint8Array, expected: Plan): PurchaseCheck
export declare function sha256(bytes: Uint8Array): string
export declare function judgeRestock(input: { readonly v1?: Uint8Array; readonly v2?: Uint8Array; readonly v1ShaAtPresent?: string; readonly v1ShaAtEnd?: string }): { pass: boolean; problems: string[]; v1: PurchaseCheck; v2: PurchaseCheck }
