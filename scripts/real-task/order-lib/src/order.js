import { STOCK, unitPrice } from './catalog.js'
import { discountFor } from './discount.js'
import { checkStock } from './inventory.js'

export { OutOfStockError } from './inventory.js'

/**
 * Price an order. `lines` is a list of `{ sku, qty }`; the same SKU may appear
 * on several lines. Returns `{ subtotal, discount, total }` in cents.
 */
export function priceOrder(lines, { code, stock = STOCK } = {}) {
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) throw new Error(`bad quantity for ${line.sku}`)
  }
  checkStock(lines, stock)
  const subtotal = lines.reduce((sum, line) => sum + unitPrice(line.sku) * line.qty, 0)
  const discount = discountFor(subtotal, code)
  return { subtotal, discount, total: subtotal - discount }
}
