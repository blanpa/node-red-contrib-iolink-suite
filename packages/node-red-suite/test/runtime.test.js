'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { PortIdentityCache, resolveDevice, shapeOutput, splitOutput, fail, shorten } =
  require('../lib/runtime')
const { IoddStore } = require('../lib/iodd-store')

const store = () => new IoddStore({ localDir: path.join(__dirname, 'fixtures'), offline: true })

/** Counts how often the port was actually scanned. */
function countingAdapter (status = { port: 1, connected: true, vendorId: 999, deviceId: 4242 }) {
  return { scans: 0, async scanPorts () { this.scans++; return [status] } }
}

test('the identity cache scans once per port within the TTL', async () => {
  const cache = new PortIdentityCache(10000)
  const adapter = countingAdapter()
  await cache.get(adapter, 1)
  await cache.get(adapter, 1)
  await cache.get(adapter, 1)
  assert.equal(adapter.scans, 1, 'a cached port must not be re-scanned')
})

test('each port is cached separately', async () => {
  const cache = new PortIdentityCache(10000)
  const adapter = countingAdapter()
  await cache.get(adapter, 1)
  await cache.get(adapter, 2)
  assert.equal(adapter.scans, 2)
})

test('force re-scans even inside the TTL', async () => {
  const cache = new PortIdentityCache(10000)
  const adapter = countingAdapter()
  await cache.get(adapter, 1)
  await cache.get(adapter, 1, { force: true })
  assert.equal(adapter.scans, 2)
})

test('an expired entry is re-scanned, so a swapped device is noticed', async () => {
  const cache = new PortIdentityCache(0)
  const adapter = countingAdapter()
  await cache.get(adapter, 1)
  await cache.get(adapter, 1)
  assert.equal(adapter.scans, 2)
})

test('clearing the cache forgets every port', async () => {
  const cache = new PortIdentityCache(10000)
  const adapter = countingAdapter()
  await cache.get(adapter, 1)
  cache.clear()
  await cache.get(adapter, 1)
  assert.equal(adapter.scans, 2)
})

test('resolveDevice loads the IODD of whatever is on the port', async () => {
  const master = { adapter: countingAdapter(), iodd: store(), parseOptions: () => ({}) }
  const { device, vendorId, deviceId, source } = await resolveDevice(master, 1, {
    identityCache: new PortIdentityCache()
  })
  assert.equal(vendorId, 999)
  assert.equal(deviceId, 4242)
  assert.equal(device.identity.vendorName, 'Test Instruments GmbH')
  assert.equal(source, 'file')
})

test('a pinned identity skips the scan entirely', async () => {
  const adapter = countingAdapter()
  const master = { adapter, iodd: store(), parseOptions: () => ({}) }
  const { device } = await resolveDevice(master, 1, {
    identityCache: new PortIdentityCache(), vendorId: 999, deviceId: 4242
  })
  assert.equal(device.identity.deviceId, 4242)
  assert.equal(adapter.scans, 0, 'a pinned identity must not cost a scan')
})

test('an empty port fails with a code a flow can branch on', async () => {
  const master = {
    adapter: countingAdapter({ port: 2, connected: false, statusText: 'no device' }),
    iodd: store(),
    parseOptions: () => ({})
  }
  const e = await resolveDevice(master, 2, { identityCache: new PortIdentityCache() }).catch(e => e)
  assert.equal(e.code, 'IOLINK_NO_DEVICE')
  assert.equal(e.port, 2)
  // The master's own words are worth more than a generic message.
  assert.match(e.message, /port 2 reports no IO-Link device \(no device\)/)
})

test('shapeOutput carries identity, raw bytes and layout alongside the values', () => {
  const device = {
    identity: {
      vendorName: 'Test Instruments GmbH', vendorId: 999, deviceId: 4242,
      variants: [{ productId: 'DEMO-100' }], deviceName: 'Demo Temperature Sensor'
    }
  }
  const out = shapeOutput({
    payload: { Temperature: 23.47 },
    meta: { Temperature: { unit: '°C' } },
    device,
    status: { serial: 'TI-0001' },
    port: 1,
    raw: '092b0929',
    layout: { id: 'PDI_Main', octetLength: 4 }
  })
  assert.deepEqual(out.payload, { Temperature: 23.47 })
  assert.deepEqual(out.device, {
    vendor: 'Test Instruments GmbH', vendorId: 999, deviceId: 4242,
    product: 'DEMO-100', serial: 'TI-0001', port: 1
  })
  assert.deepEqual(out.iolink, { raw: '092b0929', layout: 'PDI_Main', octets: 4 })
  assert.ok(Date.parse(out.timestamp) > 0, 'timestamp must be an ISO instant')
})

test('split output makes one message per value with a topic', () => {
  const base = {
    payload: { Temperature: 23.47, Counter: 586 },
    meta: { Temperature: { unit: '°C' }, Counter: {} },
    device: { port: 1 }
  }
  const msgs = splitOutput(base, 'iolink/port1')
  assert.deepEqual(msgs.map(m => m.topic), ['iolink/port1/Temperature', 'iolink/port1/Counter'])
  assert.deepEqual(msgs.map(m => m.payload), [23.47, 586])
  assert.deepEqual(msgs[0].meta, { unit: '°C' })
})

test('split output without a prefix uses the bare value name', () => {
  const msgs = splitOutput({ payload: { A: 1 }, meta: { A: {} } }, '')
  assert.equal(msgs[0].topic, 'A')
})

test('split output keeps the incoming message properties', () => {
  // Dropping these would lose msg.res in an HTTP flow, and any correlation id
  // the caller put on the message.
  const source = { _msgid: 'abc', res: 'http-response', req: 'http-request' }
  const msgs = splitOutput({ payload: { A: 1 }, meta: { A: {} } }, 'p', source)
  assert.equal(msgs[0].res, 'http-response')
  assert.equal(msgs[0]._msgid, 'abc')
})

test('failures reach done() with the code prefixed and the node turns red', () => {
  const statuses = []
  const node = { status: s => statuses.push(s), error: () => {} }
  let reported = null
  fail(node, {}, Object.assign(new Error('port 2 reports no IO-Link device'),
    { code: 'IOLINK_NO_DEVICE' }), e => { reported = e })
  assert.equal(reported.message, 'IOLINK_NO_DEVICE: port 2 reports no IO-Link device')
  assert.equal(statuses[0].fill, 'red')
})

test('a failure without done() is reported on the node', () => {
  const errors = []
  const node = { status: () => {}, error: (text, msg) => errors.push([text, msg]) }
  const msg = { _msgid: 'x' }
  fail(node, msg, new Error('boom'), undefined)
  assert.deepEqual(errors, [['boom', msg]])
})

test('status text is shortened so it fits under the node in the editor', () => {
  assert.equal(shorten('short'), 'short')
  const long = shorten('x'.repeat(80))
  assert.equal(long.length, 40)
  assert.ok(long.endsWith('…'))
})
