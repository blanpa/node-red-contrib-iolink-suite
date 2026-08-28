'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { ERROR_CODES } = require('../src')
const { demo } = require('./helpers')

test('encodes output process data', () => {
  assert.equal(demo().encodeOut({ Valve: true, Intensity: 5 }).toString('hex'), '0b')
  assert.equal(demo().encodeOut({ Valve: false, Intensity: 0 }).toString('hex'), '00')
  assert.equal(demo().encodeOut({ Intensity: 127 }).toString('hex'), 'fe')
})

test('encode and decode round-trip', () => {
  const d = demo()
  const values = { Valve: true, Intensity: 42 }
  assert.deepEqual(d.decodeOut(d.encodeOut(values)).payload, values)
})

test('a base block preserves fields that were not supplied', () => {
  const d = demo()
  // Start from Intensity 42, valve closed; flip only the valve.
  const base = d.encodeOut({ Valve: false, Intensity: 42 })
  const out = d.encodeOut({ Valve: true }, { base })
  assert.deepEqual(d.decodeOut(out).payload, { Valve: true, Intensity: 42 })
})

test('values outside the declared range are rejected', () => {
  assert.throws(() => demo().encodeOut({ Intensity: 200 }), e => {
    assert.equal(e.code, ERROR_CODES.ENCODE)
    assert.match(e.message, /does not fit in 7 unsigned bits/)
    return true
  })
  assert.throws(() => demo().encodeOut({ Intensity: -1 }), /unsigned but got -1/)
})

test('an unknown key is an error, not a silent no-op', () => {
  assert.throws(() => demo().encodeOut({ Valve: true, Vlave: true }), e => {
    assert.equal(e.code, ERROR_CODES.ENCODE)
    assert.match(e.message, /no such process data value: "Vlave"/)
    assert.match(e.message, /Known keys: "Intensity", "Valve"/)
    return true
  })
})

test('unknown keys can be ignored deliberately', () => {
  const out = demo().encodeOut({ Valve: true, other: 1 }, { ignoreUnknown: true })
  assert.equal(out.toString('hex'), '01')
})

test('scaled values are converted back to raw counts', () => {
  const { encodeLayout } = require('../src')
  const layout = demo().layout('in')
  const buf = encodeLayout({ Temperature: 23.47 }, layout)
  assert.equal(buf.subarray(0, 2).toString('hex'), '092b')
})

test('booleans accept the enum text', () => {
  const layout = demo().layout('in')
  const { encodeLayout } = require('../src')
  const buf = encodeLayout({ SwitchingSignal1: 'Closed' }, layout)
  assert.equal(buf[3] & 1, 1)
})
