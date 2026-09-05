'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { applyScale, removeScale, decimalsOf } = require('../../lib/iodd/codec/scale')

test('scaling does not leak binary floating point noise', () => {
  // 2347 * 0.01 is 23.470000000000002 in plain IEEE 754.
  assert.equal(applyScale(2347, { gradient: 0.01, offset: 0 }), 23.47)
  assert.equal(applyScale(1, { gradient: 0.1 }), 0.1)
  assert.equal(applyScale(3, { gradient: 0.3 }), 0.9)
})

test('displayFormat decimals win over the gradient\'s own precision', () => {
  assert.equal(applyScale(230, { gradient: 0.18, offset: 32, decimals: 1 }), 73.4)
  assert.equal(applyScale(1, { gradient: 1 / 3, decimals: 2 }), 0.33)
})

test('unscaled values pass through untouched', () => {
  assert.equal(applyScale(42, {}), 42)
  assert.equal(applyScale(true, {}), true)
})

test('integer scaling keeps BigInt exact', () => {
  assert.equal(applyScale(2n ** 60n, { gradient: 2, offset: 1 }), 2n ** 61n + 1n)
})

test('removeScale inverts applyScale', () => {
  for (const [raw, scale] of [[2347, { gradient: 0.01 }], [230, { gradient: 0.18, offset: 32 }],
    [-500, { gradient: 0.1, offset: 0 }]]) {
    assert.equal(removeScale(applyScale(raw, scale), scale), raw)
  }
})

test('decimalsOf reads the literal precision', () => {
  assert.equal(decimalsOf(0.01), 2)
  assert.equal(decimalsOf(1), 0)
  assert.equal(decimalsOf(0.0001), 4)
  assert.equal(decimalsOf(1e-5), 5)
})
