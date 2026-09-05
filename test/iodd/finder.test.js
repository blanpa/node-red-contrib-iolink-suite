'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { IoddFinder } = require('../../lib/iodd/finder')
const { fixture } = require('./helpers')

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iodd-finder-test-'))

const SEARCH_RESULT = {
  totalElements: 1,
  number: 0,
  content: [{
    vendorId: 999,
    deviceId: 4242,
    ioddId: 12345,
    vendorName: 'Test Instruments GmbH',
    productName: 'DEMO-100',
    versionString: 'V1.0.0',
    ioLinkRev: '1.1',
    ioddStatus: 'APPROVED',
    uploadDate: 1700000000000,
    driverName: 'TEST-DEMO-100-IODD1.1'
  }]
}

/** A ZIP holding the demo IODD, built in memory. */
function demoZip () {
  const raw = Buffer.from(fixture('demo-sensor.iodd.xml'), 'utf8')
  const data = zlib.deflateRawSync(raw)
  const name = Buffer.from('DEMO-100-IODD1.1.xml')
  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(name.length, 26); name.copy(local, 30)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42); name.copy(central, 46)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length + data.length, 16)
  return Buffer.concat([local, data, central, eocd])
}

/** Stub for global fetch, recording the URLs it was asked for. */
function stubFetch ({ fail = false } = {}) {
  const calls = []
  const fetch = async url => {
    calls.push(url)
    if (fail) throw new Error('network is down')
    if (url.includes('/drivers?')) {
      return { ok: true, status: 200, json: async () => SEARCH_RESULT }
    }
    if (url.includes('/files/zip/rated')) {
      const zip = demoZip()
      return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) }
    }
    return { ok: false, status: 404, statusText: 'Not Found' }
  }
  fetch.calls = calls
  return fetch
}

test('looks a device up by vendorId and deviceId, then caches it', async () => {
  const cacheDir = tempDir()
  const fetch = stubFetch()
  const finder = new IoddFinder({ cacheDir, fetch })

  const first = await finder.load({ vendorId: 999, deviceId: 4242 })
  assert.equal(first.source, 'network')
  assert.equal(first.device.identity.deviceId, 4242)
  assert.match(fetch.calls[0], /vendorId=999&deviceId=4242/)
  assert.match(fetch.calls[1], /\/vendors\/999\/iodds\/12345\/files\/zip\/rated$/)

  const second = await finder.load({ vendorId: 999, deviceId: 4242 })
  assert.equal(second.source, 'cache')
  assert.equal(fetch.calls.length, 2, 'the cache hit made no further requests')
})

test('falls back to the cache when the network is unavailable', async () => {
  const cacheDir = tempDir()
  await new IoddFinder({ cacheDir, fetch: stubFetch() }).load({ vendorId: 999, deviceId: 4242 })

  const offline = new IoddFinder({ cacheDir, fetch: stubFetch({ fail: true }) })
  const result = await offline.load({ vendorId: 999, deviceId: 4242, refresh: true })
  assert.equal(result.source, 'cache')
  assert.equal(result.device.identity.vendorName, 'Test Instruments GmbH')
})

test('offline mode never touches the network', async () => {
  const cacheDir = tempDir()
  await new IoddFinder({ cacheDir, fetch: stubFetch() }).load({ vendorId: 999, deviceId: 4242 })
  const fetch = stubFetch()
  const finder = new IoddFinder({ cacheDir, offline: true, fetch })
  const result = await finder.load({ vendorId: 999, deviceId: 4242 })
  assert.equal(result.source, 'cache')
  assert.equal(fetch.calls.length, 0)
})

test('an unknown device fails with a message that says what to do', async () => {
  const fetch = async url => url.includes('/drivers?')
    ? { ok: true, status: 200, json: async () => ({ totalElements: 0, number: 0, content: [] }) }
    : { ok: false, status: 404, statusText: 'Not Found' }
  const finder = new IoddFinder({ cacheDir: tempDir(), fetch })
  await assert.rejects(() => finder.load({ vendorId: 1, deviceId: 2 }),
    /has no IODD for vendorId 1, deviceId 2.*Import the vendor's IODD ZIP/s)
})

test('an IODD ZIP can be imported by hand', async () => {
  const finder = new IoddFinder({ cacheDir: tempDir(), offline: true })
  const { entry, device } = await finder.importPackage(demoZip())
  assert.equal(device.identity.deviceId, 4242)
  assert.equal(entry.vendorId, 999)
  assert.equal(entry.source, 'import')

  const loaded = await finder.load({ vendorId: 999, deviceId: 4242 })
  assert.equal(loaded.source, 'cache')
})

test('raw IODD XML can be imported too', async () => {
  const finder = new IoddFinder({ cacheDir: tempDir(), offline: true })
  const { device } = await finder.importPackage(fixture('demo-sensor.iodd.xml'))
  assert.equal(device.identity.deviceId, 4242)
})

test('needs both ids to look anything up', async () => {
  const finder = new IoddFinder({ cacheDir: tempDir(), offline: true })
  await assert.rejects(() => finder.load({ vendorId: 999 }), /need both vendorId and deviceId/)
})
