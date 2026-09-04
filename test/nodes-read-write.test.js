'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter } = require('../lib/adapters')
const { FakeMaster, DEFAULT_STATE } = require('./fake-master')
const { loadNodes, withMaster, waitFor } = require('./helpers')

/**
 * The read and write nodes, driven end to end: a real ifm adapter talking to
 * the fake master, a real IODD parsed from the fixture, and only the Node-RED
 * runtime itself stubbed out.
 */
async function setup (files) {
  const master = await new FakeMaster().listen()
  const RED = loadNodes(...files)
  withMaster(RED, createAdapter('ifm', { url: master.url, timeout: 2000 }))
  return { RED, master, close: () => master.close() }
}

test('iolink-read decodes the port into named values', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read', { master: 'master-1', port: 1, portType: 'num' })
    const [msg] = await node.receive({})

    assert.deepEqual(msg.payload, {
      Temperature: 23.47, Counter: 586, SwitchingSignal2: false, SwitchingSignal1: true
    })
    assert.equal(msg.meta.Temperature.unit, '°C')
    assert.equal(msg.device.vendor, 'Test Instruments GmbH')
    assert.equal(msg.device.product, 'DEMO-100')
    assert.equal(msg.device.port, 1)
    assert.equal(msg.iolink.raw, '092b0929')
    assert.equal(msg.iolink.octets, 4)
    assert.equal(node.lastStatus.fill, 'green')
    assert.match(node.lastStatus.text, /port 1: 4 values/)
    await node.close()
  } finally { await close() }
})

test('iolink-read passes the incoming message through', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read', { master: 'master-1', port: 1, portType: 'num' })
    const [msg] = await node.receive({ topic: 'poll', _msgid: 'abc', correlation: 42 })
    assert.equal(msg.correlation, 42)
    assert.equal(msg.topic, 'poll')
    await node.close()
  } finally { await close() }
})

test('iolink-read takes the port from the message when configured to', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: 'payload.port', portType: 'msg' })
    const err = await node.receiveExpectingError({ payload: { port: 2 } })
    // Port 2 is empty on the fake master, which is exactly what should surface.
    assert.match(err.message, /IOLINK_NO_DEVICE: port 2 reports no IO-Link device/)
    await node.close()
  } finally { await close() }
})

test('iolink-read emits only the selected values', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read', {
      master: 'master-1', port: 1, portType: 'num', values: ['Temperature', 'SwitchingSignal1']
    })
    const [msg] = await node.receive({})
    assert.deepEqual(Object.keys(msg.payload).sort(), ['SwitchingSignal1', 'Temperature'])
    assert.deepEqual(Object.keys(msg.meta).sort(), ['SwitchingSignal1', 'Temperature'])
    await node.close()
  } finally { await close() }
})

test('iolink-read in split mode sends one message per value', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read', {
      master: 'master-1', port: 1, portType: 'num', output: 'split', topicPrefix: 'plant/line1'
    })
    const [sent] = await node.receive({ _msgid: 'abc' })
    const msgs = sent[0]
    assert.equal(msgs.length, 4)
    const temperature = msgs.find(m => m.topic === 'plant/line1/Temperature')
    assert.equal(temperature.payload, 23.47)
    assert.equal(temperature.meta.unit, '°C')
    assert.equal(temperature._msgid, 'abc')
    await node.close()
  } finally { await close() }
})

test('iolink-read defaults the split topic to the port', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: 1, portType: 'num', output: 'split' })
    const [sent] = await node.receive({})
    assert.ok(sent[0].every(m => m.topic.startsWith('iolink/port1/')))
    await node.close()
  } finally { await close() }
})

test('iolink-read renders enumerations as text when asked', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: 1, portType: 'num', enums: 'text' })
    const [msg] = await node.receive({})
    // SwitchingSignal1 = true, which the IODD names "Closed".
    assert.equal(msg.payload.SwitchingSignal1, 'Closed')
    await node.close()
  } finally { await close() }
})

test('iolink-read without a master says so instead of crashing the flow', async () => {
  const RED = loadNodes('iolink-read.js')
  const node = RED.create('iolink-read', { master: 'nope' })
  assert.equal(node.lastStatus.text, 'no master configured')
  assert.equal(node.listenerCount('input'), 0)
})

test('iolink-read fails on a port the message does not carry', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: 'port', portType: 'msg' })
    // Reading port 1 instead would report another sensor's values as this one's.
    const err = await node.receiveExpectingError({})
    assert.match(err.message, /IOLINK_BAD_PORT/)
    const [msg] = await node.receive({ port: 1 })
    assert.equal(msg.device.port, 1)
    await node.close()
  } finally { await close() }
})

test('iolink-read reads as soon as it is deployed, not one interval later', async () => {
  const master = await new FakeMaster().listen()
  const RED = loadNodes('iolink-read.js')
  withMaster(RED, createAdapter('ifm', { url: master.url }))
  // A minute between ticks: anything that arrives now came from the deploy.
  const node = RED.create('iolink-read',
    { master: 'master-1', port: 1, portType: 'num', interval: 60000 })
  try {
    assert.ok(await waitFor(() => node.sent.length > 0),
      'the node should read without waiting for the first tick')
    assert.equal(node.sent.length, 1)
    assert.equal(node.sent[0].payload.Temperature, 23.47)
  } finally {
    await node.close()
    await master.close()
  }
})

test('iolink-read polls on an interval and skips a tick while one is in flight', async () => {
  const master = await new FakeMaster().listen()
  let node = null
  try {
    const RED = loadNodes('iolink-read.js')
    withMaster(RED, createAdapter('ifm', { url: master.url }))
    node = RED.create('iolink-read',
      { master: 'master-1', port: 1, portType: 'num', interval: 20 })
    assert.match(node.lastStatus.text, /polling every 20 ms/)
    assert.ok(await waitFor(() => node.sent.length >= 2),
      `expected repeated polls, got ${node.sent.length}`)
    await node.close()
    assert.equal(node.sent[0].payload.Temperature, 23.47)

    // Closing must stop the timer, and a read that was already in flight must
    // not deliver its message afterwards: a stopped flow that keeps polling a
    // master is a leak nobody sees until the master refuses connections, and a
    // message arriving after the flow stopped is a surprise on top of it.
    const after = node.sent.length
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(node.sent.length, after)
  } finally {
    // Closed here too on a failing assertion: a node left polling keeps the
    // whole test run alive, which turns one red test into a hung suite.
    if (node) await node.close()
    await master.close()
  }
})

test('iolink-write merges into the current output so other fields survive', async () => {
  const { RED, master, close } = await setup(['iolink-write.js'])
  try {
    master.state.ports[1].pdout = '0B' // Valve on, Intensity 5
    const node = RED.create('iolink-write', { master: 'master-1', port: 1, portType: 'num' })
    const [msg] = await node.receive({ payload: { Intensity: 9 } })

    // 9 << 1 | 1 = 0x13: the valve bit the message never mentioned is intact.
    assert.equal(master.state.ports[1].pdout, '13')
    assert.equal(msg.iolink.raw, '13')
    assert.equal(msg.iolink.merged, true)
    assert.deepEqual(msg.payload, { Intensity: 9 })
    assert.equal(node.lastStatus.fill, 'green')
    await node.close()
  } finally { await close() }
})

test('iolink-write without merge writes only what it was given', async () => {
  const { RED, master, close } = await setup(['iolink-write.js'])
  try {
    master.state.ports[1].pdout = '0B'
    const node = RED.create('iolink-write',
      { master: 'master-1', port: 1, portType: 'num', merge: false })
    await node.receive({ payload: { Intensity: 9 } })
    assert.equal(master.state.ports[1].pdout, '12', 'unmentioned fields go to zero')
    await node.close()
  } finally { await close() }
})

test('iolink-write does not read back when every value is supplied', async () => {
  const { RED, master, close } = await setup(['iolink-write.js'])
  try {
    const node = RED.create('iolink-write', { master: 'master-1', port: 1, portType: 'num' })
    const [msg] = await node.receive({ payload: { Valve: true, Intensity: 1 } })
    assert.equal(msg.iolink.merged, false)
    assert.equal(master.state.ports[1].pdout, '03')
    await node.close()
  } finally { await close() }
})

test('iolink-write rejects a payload that is not an object of values', async () => {
  const { RED, close } = await setup(['iolink-write.js'])
  try {
    const node = RED.create('iolink-write', { master: 'master-1', port: 1, portType: 'num' })
    const err = await node.receiveExpectingError({ payload: 'on' })
    assert.match(err.message, /IOLINK_BAD_PAYLOAD/)
    assert.match(err.message, /expected an object of values/)
    await node.close()
  } finally { await close() }
})

test('iolink-write refuses a value outside the range the IODD declares', async () => {
  const { RED, close } = await setup(['iolink-write.js'])
  try {
    const node = RED.create('iolink-write', { master: 'master-1', port: 1, portType: 'num' })
    const err = await node.receiveExpectingError({ payload: { Valve: true, Intensity: 999 } })
    assert.match(err.message, /Intensity/)
    await node.close()
  } finally { await close() }
})

test('iolink-write takes editor values as defaults the message overrides', async () => {
  const { RED, master, close } = await setup(['iolink-write.js'])
  try {
    const node = RED.create('iolink-write', {
      master: 'master-1', port: 1, portType: 'num', values: '{"Valve":true,"Intensity":2}'
    })
    await node.receive({ payload: { Intensity: 3 } })
    assert.equal(master.state.ports[1].pdout, '07') // Valve from the editor, 3 from the message
    await node.close()
  } finally { await close() }
})

/**
 * Reading several ports at once.
 *
 * The default rack has one device, so these build their own: two DEMO-100s
 * carrying different process data, which is the case the feature exists for -
 * a line of identical sensors read in one go.
 */
async function setupRack (files) {
  const state = DEFAULT_STATE()
  state.ports[2] = { ...state.ports[1], serial: 'TI-0002', pdin: '0BB80531' }
  const master = await new FakeMaster(state).listen()
  const RED = loadNodes(...files)
  withMaster(RED, createAdapter('ifm', { url: master.url, timeout: 2000 }))
  return { RED, master, close: () => master.close() }
}

test('iolink-read reads several ports into one message, keyed by port', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: '1,2', portType: 'str' })
    const [msg] = await node.receive({})

    assert.deepEqual(Object.keys(msg.payload), ['1', '2'])
    assert.equal(msg.payload[1].Temperature, 23.47)
    // A different pdin on port 2: the ports are decoded separately, not once.
    assert.notEqual(msg.payload[2].Temperature, msg.payload[1].Temperature)
    // Every part of the single-port message keeps its name under the port key.
    assert.equal(msg.meta[1].Temperature.unit, '°C')
    assert.equal(msg.device[2].serial, 'TI-0002')
    assert.equal(msg.device[2].port, 2)
    assert.equal(msg.iolink[2].raw, '0bb80531')
    assert.equal(msg.errors, undefined)
    assert.match(node.lastStatus.text, /2 ports: 8 values/)
    await node.close()
  } finally { await close() }
})

test('iolink-read still emits the flat message for a single port', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    // The list form with one port in it must not change the shape: a flow that
    // reads one port cannot be made to break by this feature existing.
    const node = RED.create('iolink-read',
      { master: 'master-1', port: '1', portType: 'str' })
    const [msg] = await node.receive({})
    assert.equal(msg.payload.Temperature, 23.47)
    assert.equal(msg.device.port, 1)
    await node.close()
  } finally { await close() }
})

test('iolink-read keeps the ports that answered when one does not', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    // Port 3 is a digital input, not IO-Link. An empty socket in the middle of
    // a rack is a normal state of a plant, and must not cost the other ports
    // their reading.
    const node = RED.create('iolink-read',
      { master: 'master-1', port: '1,3', portType: 'str' })
    const [msg] = await node.receive({})
    assert.deepEqual(Object.keys(msg.payload), ['1'])
    assert.match(msg.errors[3], /IOLINK_NO_DEVICE/)
    assert.match(node.lastStatus.text, /1 of 2 ports/)
    await node.close()
  } finally { await close() }
})

test('iolink-read fails when no port in the list answers', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: '3,4', portType: 'str' })
    const err = await node.receiveExpectingError({})
    assert.match(err.message, /IOLINK_NO_DATA: no port answered/)
    await node.close()
  } finally { await close() }
})

test('iolink-read puts the port in the topic when splitting several ports', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    // Two devices of one type carry the same value names, so a shared prefix
    // would publish both ports' Temperature to one topic.
    const node = RED.create('iolink-read', {
      master: 'master-1', port: '1,2', portType: 'str', output: 'split', topicPrefix: 'plant'
    })
    const [sent] = await node.receive({})
    const topics = sent[0].map(m => m.topic)
    assert.equal(sent[0].length, 8)
    assert.ok(topics.includes('plant/port1/Temperature'), topics.join(', '))
    assert.ok(topics.includes('plant/port2/Temperature'), topics.join(', '))
    await node.close()
  } finally { await close() }
})

test('iolink-read reads a port named twice only once', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: '1,1', portType: 'str' })
    const [msg] = await node.receive({})
    // One port after de-duplication, so the flat shape - not a key "1" twice.
    assert.equal(msg.payload.Temperature, 23.47)
    await node.close()
  } finally { await close() }
})

test('iolink-read takes a list of ports from the message', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: 'ports', portType: 'msg' })
    const [msg] = await node.receive({ ports: [1, 2] })
    assert.deepEqual(Object.keys(msg.payload), ['1', '2'])
    await node.close()
  } finally { await close() }
})

test('iolink-read tells an unreachable master from an empty port', async () => {
  const { RED, master, close } = await setup(['iolink-read.js'])
  try {
    const adapter = RED.nodes.getNode('master-1').adapter
    const node = RED.create('iolink-read', { master: 'master-1', port: 1, portType: 'num' })
    await master.close()

    const err = await node.receiveExpectingError({})
    assert.match(err.message, /^IOLINK_MASTER_UNREACHABLE: port 1 could not be asked/)
    assert.match(node.lastStatus.text, /could not be asked/)

    // Back on the air: the next read must work at once, not after the re-check
    // has expired. The fake master cannot come back on the same port, so the
    // adapter is pointed at a fresh one.
    const again = await new FakeMaster().listen()
    try {
      adapter.baseUrl = again.url
      const [msg] = await node.receive({})
      assert.equal(msg.payload.Temperature, 23.47)
    } finally { await again.close() }
    await node.close()
  } finally { await close().catch(() => {}) }
})

test('iolink-read names the ports that failed on every split message', async () => {
  const { RED, close } = await setupRack(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read',
      { master: 'master-1', port: '1,3', portType: 'str', output: 'split' })
    const [sent] = await node.receive({})
    const msgs = sent[0]
    assert.equal(msgs.length, 4)
    assert.ok(msgs.every(m => /IOLINK_NO_DEVICE/.test(m.errors[3])),
      'a message per value has nowhere else to carry the failed ports')
    await node.close()
  } finally { await close() }
})

test('iolink-read warns once about a selected value the device does not carry', async () => {
  const { RED, close } = await setup(['iolink-read.js'])
  try {
    const node = RED.create('iolink-read', {
      master: 'master-1', port: 1, portType: 'num', values: ['Temperature', 'Humidity']
    })
    const [msg] = await node.receive({})
    await node.receive({})
    assert.deepEqual(Object.keys(msg.payload), ['Temperature'])
    assert.equal(node.warnings.length, 1, 'once, not on every poll')
    assert.match(node.warnings[0], /port 1: the selected value Humidity is not in this device's process data/)
    assert.match(node.warnings[0], /it has: Temperature, Counter/)
    await node.close()
  } finally { await close() }
})

test('iolink-write reports the device the same way iolink-read does', async () => {
  const { RED, close } = await setup(['iolink-write.js'])
  try {
    const node = RED.create('iolink-write', { master: 'master-1', port: 1, portType: 'num' })
    const [msg] = await node.receive({ payload: { Valve: true } })
    assert.deepEqual(msg.device, {
      vendor: 'Test Instruments GmbH',
      vendorId: 999,
      deviceId: 4242,
      product: 'DEMO-100',
      serial: 'TI-0001',
      port: 1
    })
    await node.close()
  } finally { await close() }
})

test('nodes on one master share one identity cache', async () => {
  const { RED, master, close } = await setup(['iolink-read.js', 'iolink-write.js'])
  try {
    const adapter = RED.nodes.getNode('master-1').adapter
    let scans = 0
    const scanPorts = adapter.scanPorts.bind(adapter)
    adapter.scanPorts = async (...args) => { scans++; return scanPorts(...args) }

    const read = RED.create('iolink-read', { master: 'master-1', port: 1, portType: 'num' })
    const write = RED.create('iolink-write', { master: 'master-1', port: 1, portType: 'num' })
    await read.receive({})
    await write.receive({ payload: { Valve: true } })
    assert.equal(scans, 1, 'the second node on the port must be served from the first one\'s scan')
    assert.ok(master, 'the fake master is still up')
    await read.close()
    await write.close()
  } finally { await close() }
})
