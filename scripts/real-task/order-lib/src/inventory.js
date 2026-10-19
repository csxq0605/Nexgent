export class OutOfStockError extends Error {
  constructor(sku, wanted, available) {
    super(`${sku}: wanted ${wanted}, only ${available} in stock`)
    this.name = 'OutOfStockError'
    this.sku = sku
    this.wanted = wanted
    this.available = available
  }
}

/** Throw OutOfStockError when the order asks for more of a SKU than `stock` holds. */
export function checkStock(lines, stock) {
  for (const line of lines) {
    const available = stock[line.sku] ?? 0
    if (line.qty > available) throw new OutOfStockError(line.sku, line.qty, available)
  }
}
