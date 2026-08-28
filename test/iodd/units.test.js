'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { lookupUnit } = require('../../lib/iodd')
const { UNITS } = require('../../lib/iodd/units')

test('a unit code resolves to its symbol and name', () => {
  assert.deepEqual(lookupUnit(1001), { code: 1001, symbol: '°C', name: 'degree Celsius' })
  assert.deepEqual(lookupUnit('1001'), lookupUnit(1001), 'the IODD gives the code as text')
})

test('an unknown or absent code is null, not a guess', () => {
  assert.equal(lookupUnit(9999), null)
  assert.equal(lookupUnit(undefined), null)
  assert.equal(lookupUnit(''), null)
})

test('a code the source lists twice reports both readings', () => {
  // The normative table itself is ambiguous here: 1050 is bushel (UK) on one
  // row and bushel (US) on the next. Reporting one of them as the answer with
  // no further comment would be a 3% error presented as a fact.
  const unit = lookupUnit(1050)
  assert.equal(unit.symbol, 'bushel (UK)')
  assert.deepEqual(unit.alternatives, [{ symbol: 'bu (US)', name: 'bushel (US)' }])
  assert.equal(lookupUnit(1001).alternatives, undefined)
})

test('the generated table covers the whole specified range', () => {
  const codes = Object.keys(UNITS).map(Number)
  assert.equal(codes.length, 605)
  assert.ok(codes.every(c => Number.isInteger(c) && c > 0))
  // Every entry is [symbol, name] with an optional list of alternatives.
  for (const [code, entry] of Object.entries(UNITS)) {
    assert.equal(typeof entry[0], 'string', `unit ${code} has no symbol`)
    assert.equal(typeof entry[1], 'string', `unit ${code} has no name`)
    if (entry[2] !== undefined) assert.ok(Array.isArray(entry[2]))
  }
})
