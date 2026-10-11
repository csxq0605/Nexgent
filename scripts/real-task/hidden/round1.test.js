// Independent checks for round 1 (never shown to the model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discountFor } from '../src/discount.js'
import { priceOrder, OutOfStockError } from '../src/order.js'

test('hidden: thresholds are inclusive and still exclusive below', () => {
  assert.equal(discountFor(10000, 'SAVE10'), 1000)
  assert.equal(discountFor(10001, 'SAVE10'), 1000)
  assert.equal(discountFor(9999, 'SAVE10'), 0)
  assert.equal(discountFor(3000, 'FLAT5'), 500)
  assert.equal(discountFor(2999, 'FLAT5'), 0)
})

test('hidden: stock is summed across lines with a custom stock table', () => {
  const stock = { 'PEN-04': 5, 'MUG-01': 1 }
  assert.equal(priceOrder([{ sku: 'PEN-04', qty: 3 }, { sku: 'PEN-04', qty: 2 }], { stock }).subtotal, 1750)
  assert.throws(
    () => priceOrder([{ sku: 'PEN-04', qty: 3 }, { sku: 'MUG-01', qty: 1 }, { sku: 'PEN-04', qty: 3 }], { stock }),
    err => err instanceof OutOfStockError && err.sku === 'PEN-04' && err.wanted === 6 && err.available === 5,
  )
  assert.throws(() => priceOrder([{ sku: 'CAP-03', qty: 1 }], { stock }), OutOfStockError)
})
