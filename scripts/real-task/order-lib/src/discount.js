/** Discount codes: kind, value and the minimum subtotal (cents) the code needs. */
export const CODES = Object.freeze({
  SAVE10: { kind: 'percent', value: 10, minSubtotal: 10000 },
  FLAT5: { kind: 'fixed', value: 500, minSubtotal: 3000 },
})

/** Discount in cents for `subtotal` (cents) and an optional code; 0 when the code does not apply. */
export function discountFor(subtotal, code) {
  if (!code) return 0
  const rule = CODES[code]
  if (!rule) throw new Error(`unknown discount code ${code}`)
  if (subtotal > rule.minSubtotal) {
    if (rule.kind === 'percent') return Math.round(subtotal * rule.value / 100)
    return Math.min(rule.value, subtotal)
  }
  return 0
}
