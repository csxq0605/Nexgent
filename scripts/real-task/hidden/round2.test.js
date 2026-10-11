// Independent checks for round 2 (never shown to the model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shippingFor } from '../src/shipping.js'
import { priceOrder, OutOfStockError } from '../src/order.js'

test('hidden: shipping threshold', () => {
  assert.equal(shippingFor(4999), 599)
  assert.equal(shippingFor(5000), 0)
  assert.equal(shippingFor(12000), 0)
})

test('hidden: priceOrder adds shipping after the discount', () => {
  assert.deepEqual(priceOrder([{ sku: 'MUG-01', qty: 2 }]), { subtotal: 2500, discount: 0, shipping: 599, total: 3099 })
  assert.deepEqual(priceOrder([{ sku: 'MUG-01', qty: 4 }]), { subtotal: 5000, discount: 0, shipping: 0, total: 5000 })
  assert.deepEqual(priceOrder([{ sku: 'MUG-01', qty: 4 }], { code: 'FLAT5' }), { subtotal: 5000, discount: 500, shipping: 599, total: 5099 })
  assert.deepEqual(priceOrder([{ sku: 'TEE-02', qty: 3 }, { sku: 'CAP-03', qty: 2 }], { code: 'SAVE10' }), { subtotal: 10800, discount: 1080, shipping: 0, total: 9720 })
})

test('hidden: round-1 fixes still hold', () => {
  assert.throws(() => priceOrder([{ sku: 'TEE-02', qty: 2 }, { sku: 'TEE-02', qty: 2 }]), OutOfStockError)
  assert.equal(priceOrder([{ sku: 'PEN-04', qty: 2 }], { code: 'FLAT5' }).discount, 0)
})
