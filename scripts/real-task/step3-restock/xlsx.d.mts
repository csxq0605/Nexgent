// Types for xlsx.mjs (consumed by packages/test-support/tests/step3-restock.spec.ts).
export type CellValue = number | string | boolean | null
export interface ReadCell { readonly value: CellValue; readonly formula?: string }
export interface ReadSheet { readonly name: string; readonly cells: ReadonlyMap<string, ReadCell> }
export type WriteCell = number | string | null | undefined | { readonly formula: string; readonly value?: number | string | null }
export declare function zip(files: ReadonlyArray<readonly [string, string | Buffer]>, options?: { readonly compress?: boolean }): Buffer
export declare function unzip(bytes: Uint8Array): Map<string, Buffer>
export declare function parseRef(ref: string): { column: number; row: number }
export declare function columnName(column: number): string
export declare function readWorkbook(bytes: Uint8Array): { sheets: ReadSheet[] }
export declare function sheetRows(sheet: ReadSheet): Array<Array<(ReadCell & { ref: string }) | undefined> | undefined>
export declare function writeWorkbook(sheets: ReadonlyArray<{ readonly name: string; readonly rows: ReadonlyArray<ReadonlyArray<WriteCell>> }>, options?: { readonly compress?: boolean }): Buffer
