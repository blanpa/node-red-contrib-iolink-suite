'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { ERROR_CODES } = require('../../lib/iodd')
const { demo } = require('./helpers')

test('decodes a record process data block', () => {
  const { payload } = demo().decodeIn(Buffer.from([0x09, 0x2b, 0x04, 0xb1]))
  assert.deepEqual(payload, {
    Temperature: 23.47,
    Counter: 300,
    SwitchingSignal2: false,
    SwitchingSignal1: true
  })
})

test('accepts hex strings as well as buffers', () => {
  assert.deepEqual(demo().decodeIn('092b04b1').payload, demo().decodeIn(Buffer.from([9, 43, 4, 177])).payload)
  assert.equal(demo().decodeIn('09 2B 04 B1').payload.Temperature, 23.47)
})

test('metadata travels beside the values, not inside them', () => {
  const { payload, meta } = demo().decodeIn('092b04b1')
  assert.equal(typeof payload.Temperature, 'number')
  assert.equal(meta.Temperature.unit, '°C')
  assert.equal(meta.Temperature.raw, 2347)
  assert.equal(meta.Temperature.min, -50)
  assert.equal(meta.Temperature.description, 'Current process temperature')
  assert.equal(meta.SwitchingSignal1.unit, undefined)
})

test('negative values are sign extended', () => {
  // -1234 raw -> -12.34 degC
  const { payload } = demo().decodeIn('fb2e0000')
  assert.equal(payload.Temperature, -12.34)
})

test('enum text is reported for the current value', () => {
  const { meta } = demo().decodeIn('092b04b1')
  assert.equal(meta.SwitchingSignal1.text, 'Closed')
  assert.equal(meta.SwitchingSignal2.text, undefined, 'subindex 2 declares no enum')
})

test('enum mode text puts the resolved word in the payload', () => {
  const { payload } = demo().decodeIn('092b04b1', { enums: 'text' })
  assert.equal(payload.SwitchingSignal1, 'Closed')
  assert.equal(payload.Temperature, 23.47, 'values without an enum are unaffected')
})

test('a SingleValue on a measured item is reported as text but keeps its number', () => {
  // -32768 is the fixture's "Invalid measurement" marker.
  const { payload, meta } = demo().decodeIn('80000000')
  assert.equal(meta.Temperature.text, 'Invalid measurement')
  assert.equal(payload.Temperature, -327.68)
})

test('short process data is an error naming what was expected', () => {
  assert.throws(() => demo().decodeIn('092b'), e => {
    assert.equal(e.code, ERROR_CODES.DECODE)
    assert.match(e.message, /too short: got 2 octets.*needs 4/)
    return true
  })
})

test('extra octets are tolerated by default and rejected on request', () => {
  assert.equal(demo().decodeIn('092b04b100').payload.Temperature, 23.47)
  assert.throws(() => demo().decodeIn('092b04b100', { strictLength: true }), /too long/)
})

test('process data output can be decoded back', () => {
  const { payload } = demo().decodeOut('0b')
  assert.deepEqual(payload, { Valve: true, Intensity: 5 })
})
