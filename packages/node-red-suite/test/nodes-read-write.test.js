'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter } = require('../lib/adapters')
const { FakeMaster } = require('./fake-master')
const { loadNodes, withMaster } = require('./helpers')

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

test('iolink-read polls on an interval and skips a tick while one is in flight', async () => {
  const master = await new FakeMaster().listen()
  try {
    const RED = loadNodes('iolink-read.js')
    withMaster(RED, createAdapter('ifm', { url: master.url }))
    const node = RED.create('iolink-read',
      { master: 'master-1', port: 1, portType: 'num', interval: 20 })
    assert.match(node.lastStatus.text, /polling every 20 ms/)
    await new Promise(resolve => setTimeout(resolve, 150))
    await node.close()
    assert.ok(node.sent.length >= 2, `expected repeated polls, got ${node.sent.length}`)
    assert.equal(node.sent[0].payload.Temperature, 23.47)

    // Closing must stop the timer: a stopped flow that keeps polling a master
    // is a leak nobody sees until the master starts refusing connections.
    const after = node.sent.length
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(node.sent.length, after)
  } finally { await master.close() }
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
