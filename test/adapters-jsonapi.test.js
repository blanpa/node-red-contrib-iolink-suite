'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter, MasterError } = require('../lib/adapters')
const { FakeJsonMaster } = require('./fake-jsonapi-master')
const { loadNodes, withMaster } = require('./helpers')

/**
 * The JSON API profile against the stand-in that speaks the Community
 * specification: paths, byte arrays, aliases, and the error objects.
 */
async function setup (options) {
  const master = await new FakeJsonMaster(undefined, options).listen()
  const adapter = createAdapter('jsonapi', { url: master.url, timeout: 2000 })
  return { master, adapter, close: () => master.close() }
}

test('the base URL gets the /iolink/v1 prefix unless it already has one', () => {
  assert.equal(createAdapter('jsonapi', { host: '10.0.0.5' }).baseUrl, 'http://10.0.0.5/iolink/v1')
  assert.equal(createAdapter('jsonapi', { host: '10.0.0.5', httpPort: 8080, tls: true }).baseUrl,
    'https://10.0.0.5:8080/iolink/v1')
  assert.equal(createAdapter('jsonapi', { url: 'http://gw.local/iolink/v1/' }).baseUrl,
    'http://gw.local/iolink/v1')
  assert.equal(createAdapter('jsonapi', { url: 'http://gw.local/proxy/' }).baseUrl,
    'http://gw.local/proxy/iolink/v1')
})

test('identify reads the master identification', async () => {
  const { adapter, close } = await setup()
  try {
    const info = await adapter.identify()
    assert.equal(info.profile, 'jsonapi')
    assert.equal(info.product, 'AL1350')
    assert.equal(info.serial, '000123456789')
  } finally { await close() }
})

test('a scan maps the specification\'s port states and identification onto the common shape', async () => {
  const { adapter, close } = await setup()
  try {
    const [p1, p2, p3] = await adapter.scanPorts([1, 2, 3])
    assert.equal(p1.connected, true)
    assert.equal(p1.operational, true)
    assert.equal(p1.status, 'DEVICE_ONLINE')
    assert.equal(p1.statusText, 'device connected (operate)')
    assert.equal(p1.vendorId, 999)
    assert.equal(p1.deviceId, 4242)
    assert.equal(p1.productName, 'DEMO-100')
    assert.equal(p1.serial, 'TI-0001')
    assert.equal(p1.ioLinkRevision, '1.1')
    assert.equal(p2.connected, false)
    assert.equal(p2.statusText, 'no device')
    assert.equal(p3.connected, false)
    assert.equal(p3.status, 'DIGITAL_INPUT_C/Q')
  } finally { await close() }
})

test('the device is addressed by the alias the master lists, not by a guessed name', async () => {
  const { master, adapter, close } = await setup()
  try {
    const hex = await adapter.readProcessDataIn(1)
    assert.equal(hex, '092b0929')
    const paths = master.requests.map(r => r.path)
    assert.ok(paths.includes('/iolink/v1/masters/1/ports'), 'the alias list is asked for first')
    assert.ok(paths.includes('/iolink/v1/devices/Demo_Sensor/processdata/getdata/value'))
    assert.ok(!paths.some(p => p.includes('master1port1')), 'the default alias is not tried for a renamed port')
  } finally { await close() }
})

test('a renamed alias is looked up again when the old one is refused', async () => {
  const { master, adapter, close } = await setup()
  try {
    await adapter.readProcessDataIn(1)
    // Somebody renames the port in the master's configuration.
    master.aliases[1] = 'Belt_Sensor'
    master.requests.length = 0
    assert.equal(await adapter.readProcessDataIn(1), '092b0929')
    const paths = master.requests.map(r => r.path)
    assert.ok(paths.includes('/iolink/v1/devices/Demo_Sensor/processdata/getdata/value'), 'the known alias is tried')
    assert.ok(paths.includes('/iolink/v1/devices/Belt_Sensor/processdata/getdata/value'), 'then the new one')
  } finally { await close() }
})

test('the default alias is used for a port the master does not list', async () => {
  const { master, adapter, close } = await setup()
  try {
    master.state.ports[2] = { ...master.state.ports[1], serial: 'TI-0002' }
    await adapter.readProcessDataIn(2)
    assert.ok(master.requests.some(r => r.path === '/iolink/v1/devices/master1port2/processdata/getdata/value'))
  } finally { await close() }
})

test('process data out is read back and written as byte arrays', async () => {
  const { master, adapter, close } = await setup()
  try {
    assert.equal(await adapter.readProcessDataOut(1), '0b')
    await adapter.writeProcessDataOut(1, '0f')
    const write = master.requests.find(r => r.method === 'POST')
    assert.equal(write.path, '/iolink/v1/devices/Demo_Sensor/processdata/value')
    assert.deepEqual(write.body, { ioLink: { valid: true, value: [15] } })
    assert.equal(master.state.ports[1].pdout, '0F')
  } finally { await close() }
})

test('process data the master marks invalid is refused rather than decoded as stale', async () => {
  const { master, adapter, close } = await setup()
  try {
    master.state.ports[1].invalid = true
    const e = await adapter.readProcessDataIn(1).catch(e => e)
    assert.ok(e instanceof MasterError)
    assert.match(e.message, /marks the process data of port 1 as invalid/)
  } finally { await close() }
})

test('ISDU reads and writes address index and subindex the way the specification does', async () => {
  const { master, adapter, close } = await setup()
  try {
    assert.equal(await adapter.readIsdu(1, 100, 0), '092b')
    assert.equal(master.requests.at(-1).path, '/iolink/v1/devices/Demo_Sensor/parameters/100/value')
    assert.equal(master.requests.at(-1).query.format, 'byteArray')

    await adapter.writeIsdu(1, 100, 0, '0bb8')
    assert.deepEqual(master.requests.at(-1).body, [11, 184])
    assert.equal(await adapter.readIsdu(1, 100, 0), '0bb8')

    await adapter.writeIsdu(1, 100, 2, 'ff')
    assert.equal(master.requests.at(-1).path, '/iolink/v1/devices/Demo_Sensor/parameters/100/subindices/2/value')
    assert.equal(await adapter.readIsdu(1, 100, 2), 'ff')
  } finally { await close() }
})

test('the specification\'s error object is folded into the message with its code', async () => {
  const { adapter, close } = await setup()
  try {
    const e = await adapter.readIsdu(1, 999, 0).catch(e => e)
    assert.ok(e instanceof MasterError)
    assert.equal(e.apiCode, 311)
    assert.equal(e.status, 400)
    assert.match(e.message, /IO-Link parameter access error \(JSON API code 311, GET \/devices\/Demo_Sensor\/parameters\/999\/value/)
  } finally { await close() }
})

test('a port that does not exist is a port state, a master that does not answer is an outage', async () => {
  const { adapter, close } = await setup()
  try {
    const [nine] = await adapter.scanPorts([9])
    assert.equal(nine.connected, false)
    assert.equal(nine.apiCode, 303)
    assert.match(nine.statusText, /portNumber not found/)
    assert.equal(nine.error, undefined)
  } finally { await close() }
  const [gone] = await adapter.scanPorts([1])
  assert.match(gone.error, /cannot reach/)
  assert.equal(gone.connected, undefined)
})

test('the read node decodes a port through the JSON API profile like through any other', async () => {
  const { master, close } = await setup()
  try {
    const RED = loadNodes('iolink-read.js')
    withMaster(RED, createAdapter('jsonapi', { url: master.url, timeout: 2000 }))
    const node = RED.create('iolink-read', { master: 'master-1', port: 1, portType: 'num' })
    const [msg] = await node.receive({})
    assert.equal(msg.payload.Temperature, 23.47)
    assert.equal(msg.device.product, 'DEMO-100')
    assert.equal(msg.device.serial, 'TI-0001')
    assert.equal(msg.iolink.raw, '092b0929')
    await node.close()
  } finally { await close() }
})
