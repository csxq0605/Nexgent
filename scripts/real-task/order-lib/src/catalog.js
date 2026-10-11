/** Unit prices in cents. */
export const PRICES = Object.freeze({
  'MUG-01': 1250,
  'TEE-02': 2400,
  'CAP-03': 1800,
  'PEN-04': 350,
})

/** Default stock levels. */
export const STOCK = Object.freeze({
  'MUG-01': 10,
  'TEE-02': 3,
  'CAP-03': 5,
  'PEN-04': 100,
})

export function unitPrice(sku) {
  const price = PRICES[sku]
  if (price === undefined) throw new Error(`unknown sku ${sku}`)
  return price
}
