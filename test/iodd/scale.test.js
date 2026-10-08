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

test('displayFormat adds decimals but never cuts the resolution the data has', () => {
  assert.equal(applyScale(230, { gradient: 0.18, offset: 32, decimals: 1 }), 73.4)
  assert.equal(applyScale(1, { gradient: 0.333333, decimals: 2 }), 0.333333)
  assert.equal(applyScale(7, { gradient: 1, decimals: 2 }), 7)
  // Balluff BAE_PS: gradient 1/256 with "Dec.1" - a 25x loss if the hint won.
  assert.equal(applyScale(55408, { gradient: 0.00390625, offset: 0, decimals: 1 }), 216.4375)
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

test('an offset with decimals keeps its decimals even with gradient 1', () => {
  // Kelvin menus: gradient 1, offset 273.15. Rounding to the gradient's zero
  // decimals would turn 25 degC into 298 K.
  assert.equal(applyScale(25, { gradient: 1, offset: 273.15 }), 298.15)
})

test('a Float32 is never rounded to the gradient', () => {
  assert.equal(applyScale(1.4277, { gradient: 1, offset: 0, type: 'Float' }), 1.4277)
  assert.equal(applyScale(1.4277, { gradient: 1, offset: 0, type: 'Float', decimals: 2 }), 1.43)
})
