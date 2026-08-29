'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { FakeMaster } = require('./fake-master')
const { loadNodes } = require('./helpers')

/**
 * The config node and the editor endpoints behind the scan and value pickers.
 * These are what turn the editor from "type in a bit offset" into "tick the
 * values you want", so they are worth testing as carefully as the runtime.
 */
async function setup (config = {}) {
  const master = await new FakeMaster().listen()
  const RED = loadNodes('iolink-master.js')
  const node = RED.create('iolink-master', {
    id: 'master-1',
    profile: 'ifm',
    url: master.url,
    timeout: 2000,
    ioddDir: path.join(__dirname, 'fixtures'),
    offline: true,
    ports: '1,2,3',
    ...config
  })
  return { RED, node, master, close: async () => { await node.close(); await master.close() } }
}

test('the config node builds an adapter and an IODD store', async () => {
  const { node, close } = await setup()
  try {
    assert.equal(typeof node.adapter.readProcessDataIn, 'function')
    assert.equal(await node.adapter.readProcessDataIn(1), '092b0929')
    assert.deepEqual(node.parseOptions(), { language: 'en', keyStyle: 'preserve' })
    const { device, source } = await node.iodd.device(999, 4242, node.parseOptions())
    assert.equal(source, 'file')
    assert.equal(device.identity.deviceId, 4242)
  } finally { await close() }
})

test('the configured port list is parsed into numbers', async () => {
  const { node, close } = await setup({ ports: ' 1, 2 ,4 ' })
  try {
    assert.deepEqual(node.settings.ports, [1, 2, 4])
  } finally { await close() }
})

test('an unreadable port list is reported, not fatal to the config node', async () => {
  // A config node that throws in its constructor never starts, and takes every
  // node pointing at it with it. Worth saying out loud, not worth that.
  const { node, close } = await setup({ ports: 'first and second' })
  try {
    assert.equal(node.settings.ports, undefined, 'fall back to every port')
    assert.equal(node.errors.length, 1)
    assert.match(String(node.errors[0].error), /is not a list of port numbers/)
  } finally { await close() }
})

test('a broken paths JSON is ignored rather than breaking the deploy', async () => {
  const { node, close } = await setup({ profile: 'generic', paths: '{not json' })
  try {
    assert.equal(node.settings.paths, undefined)
  } finally { await close() }
})

test('credentials become the adapter\'s basic auth', async () => {
  const { node, close } = await setup({ credentials: { user: 'admin', password: 'pw' } })
  try {
    assert.deepEqual(node.adapter.auth, { user: 'admin', password: 'pw' })
  } finally { await close() }
})

test('the profile list is served to the editor', async () => {
  const { RED, close } = await setup()
  try {
    const { status, body } = await RED.callRoute('GET', '/iolink-suite/profiles')
    assert.equal(status, 200)
    assert.deepEqual(body.map(p => p.id), ['ifm', 'generic'])
  } finally { await close() }
})

test('the scan endpoint returns ports with their IODD identification', async () => {
  const { RED, close } = await setup()
  try {
    const { status, body } = await RED.callRoute('GET', '/iolink-suite/scan/:id', { id: 'master-1' })
    assert.equal(status, 200)
    assert.equal(body[0].vendorId, 999)
    assert.equal(body[0].iodd.productName, 'DEMO-100')
    assert.equal(body[0].iodd.source, 'file')
    assert.equal(body[1].connected, false)
  } finally { await close() }
})

test('the identify endpoint answers without asking about any port', async () => {
  // This is what "Test connection" runs. Scanning to answer it costs a request
  // per port and says nothing about a master with nothing plugged in yet.
  const { RED, master, close } = await setup()
  try {
    const before = master.requests.length
    const { status, body } = await RED.callRoute('GET', '/iolink-suite/identify/:id',
      { id: 'master-1' })
    assert.equal(status, 200)
    assert.equal(body.profile, 'ifm')
    assert.ok(body.product, 'the master should name itself')
    assert.ok(master.requests.length - before <= 2,
      'identifying should not walk the ports')
    assert.ok(!master.requests.some(r => /iolinkmaster\/port/.test(r.adr)))
  } finally { await close() }
})

test('the endpoints refuse an id that is not a configured master', async () => {
  const { RED, close } = await setup()
  try {
    const { status, body } = await RED.callRoute('GET', '/iolink-suite/scan/:id', { id: 'nope' })
    assert.equal(status, 404)
    assert.match(body.error, /unknown or unconfigured master/)
  } finally { await close() }
})

test('the datapoint picker lists the decoded values of a port', async () => {
  const { RED, close } = await setup()
  try {
    const { body } = await RED.callRoute('GET', '/iolink-suite/datapoints/:id/:port',
      { id: 'master-1', port: '1' })
    assert.equal(body.device.productName, 'DEMO-100')
    assert.equal(body.layout.octetLength, 4)
    const temperature = body.items.find(i => i.key === 'Temperature')
    assert.deepEqual(
      { unit: temperature.unit, bitOffset: temperature.bitOffset, bitLength: temperature.bitLength },
      { unit: '°C', bitOffset: 16, bitLength: 16 })
    assert.equal(temperature.description, 'Current process temperature')
  } finally { await close() }
})

test('the datapoint picker can be asked for the output direction', async () => {
  const { RED, close } = await setup()
  try {
    const { body } = await RED.callRoute('GET', '/iolink-suite/datapoints/:id/:port',
      { id: 'master-1', port: '1' }, { direction: 'out' })
    assert.deepEqual(body.items.map(i => i.key).sort(), ['Intensity', 'Valve'])
  } finally { await close() }
})

test('the datapoint picker reports an empty port instead of an empty list', async () => {
  const { RED, close } = await setup()
  try {
    const { status, body } = await RED.callRoute('GET', '/iolink-suite/datapoints/:id/:port',
      { id: 'master-1', port: '2' })
    assert.equal(status, 500)
    assert.match(body.error, /port 2 reports no IO-Link device/)
  } finally { await close() }
})

test('the parameter picker lists the ISDU parameters with access rights', async () => {
  const { RED, close } = await setup()
  try {
    const { body } = await RED.callRoute('GET', '/iolink-suite/parameters/:id/:port',
      { id: 'master-1', port: '1' })
    const setpoint = body.parameters.find(p => p.index === 100)
    assert.deepEqual(
      { name: setpoint.name, access: setpoint.access, unit: setpoint.unit, type: setpoint.type },
      { name: 'Switch point', access: 'rw', unit: '°C', type: 'Integer' })
    // Standard parameters are marked, so the editor can group them apart.
    assert.equal(body.parameters.find(p => p.index === 16).standard, true)
  } finally { await close() }
})
