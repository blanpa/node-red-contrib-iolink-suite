'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd } = require('../../lib/iodd')
const { corpusFiles, corpusDir } = require('./helpers')

const files = corpusFiles()
const skip = files.length === 0 &&
  `no corpus in ${corpusDir} - run \`npm run corpus\` to fetch real vendor IODDs`

test('every IODD in the corpus parses', { skip }, () => {
  const failures = []
  for (const file of files) {
    try {
      parseIodd(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      failures.push(`${path.basename(file)}: [${e.code}] ${e.message}`)
    }
  }
  assert.deepEqual(failures, [], `${failures.length}/${files.length} IODDs failed to parse`)
})

test('every process data layout is internally consistent', { skip }, () => {
  const problems = []
  for (const file of files) {
    let device
    try { device = parseIodd(fs.readFileSync(file, 'utf8')) } catch { continue }
    for (const variant of device.processData) {
      for (const layout of [variant.in, variant.out]) {
        if (!layout) continue
        const name = `${path.basename(file)} ${layout.id}`
        if (!(layout.bitLength > 0)) { problems.push(`${name}: bitLength ${layout.bitLength}`); continue }
        for (const item of layout.items) {
          if (item.bitOffset + item.bitLength > layout.octetLength * 8) {
            problems.push(`${name}: "${item.key}" runs past the block ` +
              `(${item.bitOffset}+${item.bitLength} > ${layout.octetLength * 8})`)
          }
        }
      }
    }
  }
  assert.deepEqual(problems.slice(0, 20), [])
})

test('every layout decodes a full-scale block without throwing', { skip }, () => {
  const failures = []
  for (const file of files) {
    let device
    try { device = parseIodd(fs.readFileSync(file, 'utf8')) } catch { continue }
    for (const variant of device.processData) {
      if (!variant.in) continue
      const raw = Buffer.alloc(variant.in.octetLength, 0xa5)
      try {
        const { payload } = device.decodeIn(raw, { variant: variant.id })
        assert.equal(Object.keys(payload).length, variant.in.items.length)
      } catch (e) {
        failures.push(`${path.basename(file)} ${variant.id}: ${e.message}`)
      }
    }
  }
  assert.deepEqual(failures.slice(0, 20), [])
})

/** A value each item is guaranteed to accept, so the test exercises the codec
 *  rather than the range checks. */
function representativeValue (item) {
  switch (item.type) {
    case 'Boolean': return true
    case 'String': return 'ab'
    case 'OctetString': return '00'.repeat(item.bitLength / 8)
    default: return item.min !== undefined ? item.min : 0
  }
}

test('output layouts round-trip through encode and decode', { skip }, () => {
  const failures = []
  for (const file of files) {
    let device
    try { device = parseIodd(fs.readFileSync(file, 'utf8')) } catch { continue }
    for (const variant of device.processData) {
      if (!variant.out) continue
      const values = Object.fromEntries(variant.out.items.map(i => [i.key, representativeValue(i)]))
      try {
        const encoded = device.encodeOut(values, { variant: variant.id })
        assert.equal(encoded.length, variant.out.octetLength)
        const { payload } = device.decodeOut(encoded, { variant: variant.id })
        assert.deepEqual(payload, values)
      } catch (e) {
        failures.push(`${path.basename(file)} ${variant.id}: ${e.message}`)
      }
    }
  }
  assert.deepEqual(failures.slice(0, 20), [])
})
