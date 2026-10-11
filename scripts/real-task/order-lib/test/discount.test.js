import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discountFor } from '../src/discount.js'

test('no code, no discount', () => {
  assert.equal(discountFor(5000, undefined), 0)
})

test('SAVE10 takes 10% above the minimum', () => {
  assert.equal(discountFor(12000, 'SAVE10'), 1200)
})

test('SAVE10 applies at exactly 100.00', () => {
  assert.equal(discountFor(10000, 'SAVE10'), 1000)
})

test('FLAT5 applies at exactly 30.00', () => {
  assert.equal(discountFor(3000, 'FLAT5'), 500)
})

test('codes below the minimum give nothing', () => {
  assert.equal(discountFor(2999, 'FLAT5'), 0)
  assert.equal(discountFor(9999, 'SAVE10'), 0)
})

test('unknown codes are rejected', () => {
  assert.throws(() => discountFor(5000, 'NOPE'), /unknown discount code/)
})
