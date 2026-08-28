'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter } = require('../lib/adapters')
const { FakeMaster } = require('./fake-master')
const { loadNodes, withMaster } = require('./helpers')

async function setup (file, type, config = {}) {
  const master = await new FakeMaster().listen()
  const RED = loadNodes(file)
  withMaster(RED, createAdapter('ifm', { url: master.url, timeout: 2000 }))
  const node = RED.create(type, { master: 'master-1', ...config })
  return { node, master, close: async () => { await node.close(); await master.close() } }
}

// ------------------------------------------------------------------ scan node

test('iolink-scan reports what is plugged into each port', async () => {
  const { node, close } = await setup('iolink-scan.js', 'iolink-scan', { ports: '1,2,3' })
  try {
    const [msg] = await node.receive({})
    const [one, two, three] = msg.payload
    assert.equal(one.port, 1)
    assert.equal(one.connected, true)
    assert.equal(one.vendorId, 999)
    assert.equal(one.iodd.vendorName, 'Test Instruments GmbH')
    assert.equal(one.iodd.productName, 'DEMO-100')
    assert.equal(one.iodd.parameters, 7)
    assert.equal(one.iodd.ioLinkRevision, 'V1.1')
    assert.equal(two.connected, false)
    assert.equal(two.iodd, undefined, 'an empty port has nothing to look up')
    assert.equal(three.modeText, 'digital input (DI)')
    assert.match(node.lastStatus.text, /1 of 3 ports in use/)
  } finally { await close() }
})

test('iolink-scan takes its port list from the message', async () => {
  const { node, close } = await setup('iolink-scan.js', 'iolink-scan', { ports: '1,2,3' })
  try {
    const [msg] = await node.receive({ ports: [2] })
    assert.deepEqual(msg.payload.map(p => p.port), [2])
  } finally { await close() }
})

test('iolink-scan reports a device whose IODD cannot be found, rather than failing', async () => {
  const { node, master, close } = await setup('iolink-scan.js', 'iolink-scan', { ports: '1' })
  try {
    master.state.ports[1].deviceId = 1234 // no IODD for this one, offline
    const [msg] = await node.receive({})
    assert.equal(msg.payload[0].connected, true)
    assert.ok(msg.payload[0].iodd.error, 'the missing IODD should be reported on the entry')
  } finally { await close() }
})

test('iolink-scan can be told to skip the IODD look-up', async () => {
  const { node, close } = await setup('iolink-scan.js', 'iolink-scan',
    { ports: '1', resolveIodd: false })
  try {
    const [msg] = await node.receive({})
    assert.equal(msg.payload[0].iodd, undefined)
  } finally { await close() }
})

// ----------------------------------------------------------------- event node

/**
 * Long interval: the tests drive the polling themselves, one step at a time.
 * The node takes its baseline as soon as it is deployed, so the helper waits
 * for that one poll to land before the test starts changing the master.
 */
async function eventNode (config) {
  const made = await setup('iolink-event.js', 'iolink-event',
    { ports: '1,2', interval: 60000, ...config })
  await new Promise(resolve => setTimeout(resolve, 50))
  return made
}

test('iolink-event stays quiet on the first poll', async () => {
  const { node, close } = await eventNode()
  try {
    // The first poll is the baseline. Reporting every port as "changed" on
    // deploy would fire an alarm for a plant that is perfectly healthy.
    assert.deepEqual(node.sent, [], 'the baseline poll must emit nothing')
    assert.deepEqual(await node.receive({}), [])
    assert.match(node.lastStatus.text, /1\/2 ports connected/)
  } finally { await close() }
})

test('iolink-event reads device status when asked, and only then', async () => {
  const plain = await eventNode()
  try {
    await plain.node.receive({})
    assert.ok(!plain.master.requests.some(r => /iolreadacyclic/.test(r.adr)),
      'no ISDU traffic unless device status is switched on')
  } finally { await plain.close() }

  const { node, master, close } = await eventNode({ deviceStatus: true })
  try {
    // The demo device says "maintenance required" and gives the reason.
    master.state.ports[1].status = 1
    const [sent] = await node.receive({})
    const [msg] = sent[0]
    assert.equal(msg.payload.deviceStatus, 1)
    assert.equal(msg.payload.deviceStatusText, 'Maintenance required')
    assert.equal(msg.payload.deviceEvents.length, 1)
    assert.equal(msg.payload.deviceEvents[0].name, 'Maintenance required - Cleaning')
    assert.equal(msg.payload.deviceEvents[0].type, 'Warning')
    assert.match(node.lastStatus.text, /Maintenance required/)
  } finally { await close() }
})

test('iolink-event reports a device event appearing later', async () => {
  const { node, master, close } = await eventNode({ deviceStatus: true })
  try {
    // Baseline was taken with the standing "cleaning" warning; a second event
    // showing up is a change worth a message.
    assert.deepEqual(await node.receive({}), [])
    master.state.ports[1].isdu['37/0'] = 'E48C40' + 'F45110'
    const [sent] = await node.receive({})
    const [msg] = sent[0]
    assert.deepEqual(msg.payload.deviceEvents.map(e => e.hex), ['0x8C40', '0x5110'])
    assert.ok(msg.changes.some(c => c.field === 'deviceEventCodes'))
  } finally { await close() }
})

test('a device that will not answer index 36 does not stop the port watch', async () => {
  const { node, master, close } = await eventNode({ deviceStatus: true })
  try {
    delete master.state.ports[1].isdu['36/0']
    master.state.ports[2].status = 2
    const [sent] = await node.receive({})
    // Port 2 appearing is still reported, and port 1 says why it has no status.
    assert.ok(sent[0].some(m => m.payload.port === 2 && m.payload.connected === true))
    await node.receive({})
    assert.equal(node.lastStatus.fill, 'green')
  } finally { await close() }
})

test('iolink-event reports a device appearing', async () => {
  const { node, master, close } = await eventNode()
  try {
    await node.receive({})
    Object.assign(master.state.ports[2],
      { status: 2, vendorId: 999, deviceId: 4242, productName: 'DEMO-100' })

    const [sent] = await node.receive({})
    const [msg] = sent[0]
    assert.equal(msg.topic, 'iolink/port2/status')
    assert.equal(msg.payload.connected, true)
    assert.equal(msg.payload.vendorId, 999)
    assert.equal(msg.event.direction, 'appeared')
    assert.ok(msg.changes.some(c => c.field === 'connected' && c.to === true))
  } finally { await close() }
})

test('iolink-event reports a device disappearing', async () => {
  const { node, master, close } = await eventNode()
  try {
    await node.receive({})
    master.state.ports[1].status = 0

    const [sent] = await node.receive({})
    const [msg] = sent[0]
    assert.equal(msg.payload.port, 1)
    assert.equal(msg.event.direction, 'disappeared')
    assert.equal(msg.payload.connected, false)
  } finally { await close() }
})

test('iolink-event reports a swapped device', async () => {
  const { node, master, close } = await eventNode()
  try {
    await node.receive({})
    master.state.ports[1].deviceId = 4243

    const [sent] = await node.receive({})
    assert.equal(sent[0][0].event.direction, 'device changed')
  } finally { await close() }
})

test('iolink-event says nothing while nothing changes', async () => {
  const { node, close } = await eventNode()
  try {
    await node.receive({})
    assert.deepEqual(await node.receive({}), [])
    assert.deepEqual(await node.receive({}), [])
  } finally { await close() }
})

test('iolink-event polls on its own timer and stops on close', async () => {
  const master = await new FakeMaster().listen()
  try {
    const RED = loadNodes('iolink-event.js')
    withMaster(RED, createAdapter('ifm', { url: master.url }))
    const node = RED.create('iolink-event', { master: 'master-1', ports: '1', interval: 250 })
    await new Promise(resolve => setTimeout(resolve, 300))
    master.state.ports[1].status = 0
    await new Promise(resolve => setTimeout(resolve, 300))
    await node.close()
    assert.ok(node.sent.length >= 1, 'the timer should have produced the change')

    const requests = master.requests.length
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(master.requests.length, requests, 'a closed node must stop polling')
  } finally { await master.close() }
})

test('iolink-event below the floor still polls at a sane rate', async () => {
  // A 0 ms interval in the editor would otherwise busy-loop against the master.
  const { node, close } = await setup('iolink-event.js', 'iolink-event',
    { ports: '1', interval: 0 })
  try {
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.ok(node.sent.length <= 1)
  } finally { await close() }
})
