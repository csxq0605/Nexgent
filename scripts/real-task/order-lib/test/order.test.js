import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceOrder, OutOfStockError } from '../src/order.js'

test('prices a simple order', () => {
  assert.deepEqual(priceOrder([{ sku: 'MUG-01', qty: 2 }]), { subtotal: 2500, discount: 0, total: 2500 })
})

test('applies a discount code', () => {
  const result = priceOrder([{ sku: 'TEE-02', qty: 3 }, { sku: 'CAP-03', qty: 2 }], { code: 'SAVE10' })
  assert.deepEqual(result, { subtotal: 10800, discount: 1080, total: 9720 })
})

test('stock is checked per line', () => {
  assert.throws(() => priceOrder([{ sku: 'TEE-02', qty: 4 }]), OutOfStockError)
})

test('stock is checked across lines of the same SKU', () => {
  assert.throws(
    () => priceOrder([{ sku: 'TEE-02', qty: 2 }, { sku: 'MUG-01', qty: 1 }, { sku: 'TEE-02', qty: 2 }]),
    err => err instanceof OutOfStockError && err.sku === 'TEE-02' && err.wanted === 4 && err.available === 3,
  )
})

test('an order that uses exactly the stock passes', () => {
  const result = priceOrder([{ sku: 'TEE-02', qty: 1 }, { sku: 'TEE-02', qty: 2 }])
  assert.equal(result.subtotal, 7200)
})

test('rejects bad quantities', () => {
  assert.throws(() => priceOrder([{ sku: 'PEN-04', qty: 0 }]), /bad quantity/)
})
