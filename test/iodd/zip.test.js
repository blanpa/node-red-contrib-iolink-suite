'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { listEntries, readEntry, extractIodd } = require('../../lib/iodd/zip')
const { fixture } = require('./helpers')

/** Build a ZIP archive in memory, so the test needs no binary fixture. */
function makeZip (files, { deflate = true } = {}) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const data = deflate ? zlib.deflateRawSync(raw) : raw
    const method = deflate ? 8 : 0
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14) // crc, unchecked by the reader
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(centrals.length, 8)
  eocd.writeUInt16LE(centrals.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('lists and reads deflated entries', () => {
  const zip = makeZip({ 'a.xml': '<IODevice/>', 'logo.png': 'not really a png' })
  const entries = listEntries(zip)
  assert.deepEqual(entries.map(e => e.name), ['a.xml', 'logo.png'])
  assert.equal(readEntry(zip, entries[0]).toString(), '<IODevice/>')
  assert.equal(readEntry(zip, entries[1]).toString(), 'not really a png')
})

test('reads stored (uncompressed) entries', () => {
  const zip = makeZip({ 'a.xml': '<IODevice/>' }, { deflate: false })
  const [entry] = listEntries(zip)
  assert.equal(readEntry(zip, entry).toString(), '<IODevice/>')
})

test('picks the IODD out of a package full of images', () => {
  const zip = makeZip({
    'vendor-logo.png': 'png bytes',
    'DEVICE-20260101-IODD1.1.xml': fixture('demo-sensor.iodd.xml'),
    'device-pic.png': 'more png bytes'
  })
  const { name, xml } = extractIodd(zip)
  assert.equal(name, 'DEVICE-20260101-IODD1.1.xml')
  assert.match(xml, /<IODevice/)
})

test('refuses a package holding several IODDs rather than guessing', () => {
  const zip = makeZip({ 'a.xml': '<IODevice a="1"/>', 'b.xml': '<IODevice b="2"/>' })
  assert.throws(() => extractIodd(zip), /contains 2 IODD files/)
})

test('rejects data that is not a ZIP', () => {
  assert.throws(() => listEntries(Buffer.from('definitely not a zip archive')),
    /no end-of-central-directory/)
})

test('reports a package with no XML clearly', () => {
  const zip = makeZip({ 'readme.txt': 'hello' })
  assert.throws(() => extractIodd(zip), /contains no .xml file/)
})
