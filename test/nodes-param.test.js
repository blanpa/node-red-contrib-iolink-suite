'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter } = require('../lib/adapters')
const { FakeMaster } = require('./fake-master')
const { loadNodes, withMaster } = require('./helpers')

/** The parameter node against a real adapter, a real IODD and a fake master. */
async function setup (config = {}) {
  const master = await new FakeMaster().listen()
  const RED = loadNodes('iolink-param.js')
  withMaster(RED, createAdapter('ifm', { url: master.url, timeout: 2000 }))
  const node = RED.create('iolink-param', { master: 'master-1', port: 1, portType: 'num', ...config })
  return { node, master, close: async () => { await node.close(); await master.close() } }
}

test('reads a parameter by its name and scales it through the IODD', async () => {
  const { node, close } = await setup({ parameter: 'Switch point' })
  try {
    const [msg] = await node.receive({})
    assert.equal(msg.payload, 23.47)
    assert.equal(msg.meta.unit, '°C')
    assert.equal(msg.meta.raw, 2347)
    assert.deepEqual({ index: msg.iolink.index, subindex: msg.iolink.subindex, raw: msg.iolink.raw },
      { index: 100, subindex: 0, raw: '092b' })
    assert.equal(msg.device.vendor, 'Test Instruments GmbH')
    assert.match(node.lastStatus.text, /Switch point = 23.47 °C/)
  } finally { await close() }
})

test('a parameter can also be addressed by index', async () => {
  const { node, close } = await setup({ parameter: '100' })
  try {
    assert.equal((await node.receive({}))[0].payload, 23.47)
  } finally { await close() }
})

test('the parameter can come from the message', async () => {
  const { node, close } = await setup({ parameter: 'parameter', parameterType: 'msg' })
  try {
    const [msg] = await node.receive({ parameter: 'Output polarity' })
    assert.equal(msg.payload, 1)
    // The IODD names the value; a flow should not have to know that 1 means NC.
    assert.equal(msg.meta.text, 'Normally closed')
  } finally { await close() }
})

test('a String parameter shorter than its declared length decodes cleanly', async () => {
  // The IODD declares 8 bytes; the device answers with 6. Decoding against the
  // declared length would append two NUL characters to every label.
  const { node, close } = await setup({ parameter: 'Label' })
  try {
    assert.equal((await node.receive({}))[0].payload, 'Line A')
  } finally { await close() }
})

test('a standard parameter is read like any other', async () => {
  const { node, close } = await setup({ parameter: 'VendorName' })
  try {
    assert.equal((await node.receive({}))[0].payload, 'Test Instruments GmbH')
  } finally { await close() }
})

test('writing a parameter removes the scaling before it goes on the wire', async () => {
  const { node, master, close } = await setup({ parameter: 'Switch point', action: 'write' })
  try {
    const [msg] = await node.receive({ payload: 30 })
    assert.equal(master.state.ports[1].isdu['100/0'], '0BB8') // 30 / 0.01 = 3000
    assert.equal(msg.iolink.raw, '0bb8')
    assert.match(node.lastStatus.text, /wrote Switch point/)
  } finally { await close() }
})

test('a write reports the device it went to, as a read does', async () => {
  // A flow that logs or correlates on device and timestamp should not have to
  // special-case the direction.
  const { node, close } = await setup({ parameter: 'Switch point', action: 'write' })
  try {
    const [msg] = await node.receive({ payload: 30 })
    assert.deepEqual(msg.device, {
      vendor: 'Test Instruments GmbH', product: 'DEMO-100', port: 1
    })
    assert.match(msg.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  } finally { await close() }
})

test('a write can be requested per message', async () => {
  const { node, master, close } = await setup({ parameter: 'Switch point' })
  try {
    await node.receive({ action: 'write', payload: 10 })
    assert.equal(master.state.ports[1].isdu['100/0'], '03E8')
  } finally { await close() }
})

test('an enumeration can be written by its name', async () => {
  const { node, master, close } = await setup({ parameter: 'Output polarity', action: 'write' })
  try {
    await node.receive({ payload: 'Normally open' })
    assert.equal(master.state.ports[1].isdu['101/0'], '00')
  } finally { await close() }
})

test('a value outside the declared range is refused before it is written', async () => {
  const { node, master, close } = await setup({ parameter: 'Switch point', action: 'write' })
  try {
    const before = master.state.ports[1].isdu['100/0']
    const err = await node.receiveExpectingError({ payload: 500 })
    assert.match(err.message, /IOLINK_OUT_OF_RANGE/)
    assert.match(err.message, /above the declared maximum 150/)
    assert.equal(master.state.ports[1].isdu['100/0'], before, 'nothing may reach the device')
  } finally { await close() }
})

test('a read-only parameter cannot be written', async () => {
  const { node, close } = await setup({ parameter: 'VendorName', action: 'write' })
  try {
    const err = await node.receiveExpectingError({ payload: 'Someone Else' })
    assert.match(err.message, /IOLINK_READ_ONLY/)
    assert.match(err.message, /"VendorName" \(index 16\) is read-only/)
  } finally { await close() }
})

test('an unknown parameter lists what the device does have', async () => {
  const { node, close } = await setup({ parameter: 'Schaltpunkt' })
  try {
    const err = await node.receiveExpectingError({})
    assert.match(err.message, /IOLINK_UNKNOWN_PARAMETER/)
    assert.match(err.message, /Known: 16 VendorName/)
  } finally { await close() }
})

test('no parameter selected is its own error', async () => {
  const { node, close } = await setup({})
  try {
    assert.match((await node.receiveExpectingError({})).message, /IOLINK_NO_PARAMETER/)
  } finally { await close() }
})

test('an index the device rejects surfaces the master\'s code', async () => {
  const { node, master, close } = await setup({ parameter: 'Label' })
  try {
    delete master.state.ports[1].isdu['102/0']
    const err = await node.receiveExpectingError({})
    assert.match(err.message, /code 801/)
  } finally { await close() }
})
