'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { ERROR_CODES } = require('../../lib/iodd')
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
  const { encodeLayout } = require('../../lib/iodd')
  const layout = demo().layout('in')
  const buf = encodeLayout({ Temperature: 23.47 }, layout)
  assert.equal(buf.subarray(0, 2).toString('hex'), '092b')
})

test('booleans accept the enum text', () => {
  const layout = demo().layout('in')
  const { encodeLayout } = require('../../lib/iodd')
  const buf = encodeLayout({ SwitchingSignal1: 'Closed' }, layout)
  assert.equal(buf[3] & 1, 1)
})

test('a padded base keeps the leading octets, like decoding does', () => {
  const d = demo()
  // A master that pads its reply puts the real block first; anchoring on the
  // end would seed every field with padding and zero the untouched ones.
  const base = Buffer.concat([d.encodeOut({ Valve: false, Intensity: 42 }), Buffer.from([0, 0])])
  const out = d.encodeOut({ Valve: true }, { base })
  assert.deepEqual(d.decodeOut(out).payload, { Valve: true, Intensity: 42 })
})

test('numeric strings are scaled and range-checked like numbers', () => {
  const { encodeLayout } = require('../../lib/iodd')
  const layout = { octetLength: 2, bitLength: 16, items: [{ key: 't', type: 'UInteger', bitOffset: 0, bitLength: 16, gradient: 0.1, offset: 0, max: 100 }] }
  assert.equal(encodeLayout({ t: '23.5' }, layout).toString('hex'), encodeLayout({ t: 23.5 }, layout).toString('hex'))
  assert.throws(() => encodeLayout({ t: '150' }, layout), /above the declared maximum/)
})

test('US-ASCII is ASCII', () => {
  const { encodeItem, decodeItem } = require('../../lib/iodd')
  const item = { key: 's', type: 'String', bitOffset: 0, bitLength: 32, encoding: 'US-ASCII' }
  const buf = encodeItem(Buffer.alloc(4), item, 'ü')
  assert.equal(buf.toString('hex'), 'fc000000')
  assert.equal(decodeItem(Buffer.from('41420000', 'hex'), item), 'AB')
})

test('a string that is not a decimal number is refused, not written as a raw count', () => {
  const { encodeLayout } = require('../../lib/iodd')
  const layout = { octetLength: 2, bitLength: 16, items: [{ key: 't', type: 'UInteger', bitOffset: 0, bitLength: 16, gradient: 0.1, offset: 0 }] }
  for (const bad of ['0x10', '1e2', 'abc', '']) {
    assert.throws(() => encodeLayout({ t: bad }, layout), e => {
      assert.equal(e.code, ERROR_CODES.ENCODE)
      assert.match(e.message, /needs a number/)
      return true
    })
  }
})
