'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { loadNodes, DEMO_IODD } = require('./helpers')

/**
 * The decode node needs no master at all: it is the entry point for process
 * data that arrives over PROFINET, OPC UA, MQTT or a PLC.
 */
const decoder = config => {
  const RED = loadNodes('iodd-decode.js')
  return RED.create('iodd-decode', { iodd: DEMO_IODD, ...config })
}

test('decodes raw hex into named values with no master involved', async () => {
  const node = decoder()
  const [msg] = await node.receive({ payload: '092b0929' })
  assert.deepEqual(msg.payload, {
    Temperature: 23.47, Counter: 586, SwitchingSignal2: false, SwitchingSignal1: true
  })
  assert.equal(msg.meta.Temperature.unit, '°C')
  assert.equal(msg.device.vendorId, 999)
  assert.equal(msg.iolink.layout, 'PDI_Main')
  assert.equal(msg.iolink.octets, 4)
})

test('accepts a Buffer as well as a hex string', async () => {
  const node = decoder()
  const [msg] = await node.receive({ payload: Buffer.from('092b0929', 'hex') })
  assert.equal(msg.payload.Temperature, 23.47)
  assert.equal(msg.iolink.raw, '092b0929')
})

test('shows the loaded device in its status once configured', () => {
  const node = decoder()
  assert.equal(node.lastStatus.fill, 'green')
  assert.match(node.lastStatus.text, /Test Instruments GmbH DEMO-100/)
})

test('decodes the output direction when asked', async () => {
  const node = decoder({ direction: 'out' })
  const [msg] = await node.receive({ payload: '0b' })
  assert.deepEqual(msg.payload, { Valve: true, Intensity: 5 })
})

test('the direction can be set per message', async () => {
  const node = decoder()
  const [msg] = await node.receive({ payload: '0b', direction: 'out' })
  assert.deepEqual(msg.payload, { Valve: true, Intensity: 5 })
})

test('encode mode turns values back into hex', async () => {
  const node = decoder({ mode: 'encode' })
  const [msg] = await node.receive({ payload: { Valve: true, Intensity: 5 } })
  assert.equal(msg.payload, '0b')
  assert.equal(msg.iolink.octets, 1)
})

test('an IODD on the message wins over the configured one', async () => {
  const node = decoder({ iodd: '' })
  const [msg] = await node.receive({
    payload: '092b0929', iodd: fs.readFileSync(DEMO_IODD, 'utf8')
  })
  assert.equal(msg.payload.Temperature, 23.47)
})

test('an IODD path on the message is read from disk', async () => {
  const node = decoder({ iodd: '' })
  const [msg] = await node.receive({ payload: '092b0929', iodd: DEMO_IODD })
  assert.equal(msg.payload.Temperature, 23.47)
})

test('the language chooses which names the values get', async () => {
  const node = decoder({ language: 'de' })
  const [msg] = await node.receive({ payload: '092b0929' })
  assert.ok('Temperatur' in msg.payload, `expected German names, got ${Object.keys(msg.payload)}`)
})

test('the key style can be adapted to what the rest of the flow expects', async () => {
  const node = decoder({ keyStyle: 'camel' })
  const [msg] = await node.receive({ payload: '092b0929' })
  assert.ok('temperature' in msg.payload, `got ${Object.keys(msg.payload)}`)
})

test('an empty payload is refused with a code', async () => {
  const node = decoder()
  const err = await node.receiveExpectingError({ payload: '' })
  assert.match(err.message, /IOLINK_NO_DATA/)
  assert.match(err.message, /msg.payload holds no data/)
})

test('no IODD configured is reported on the node before any message arrives', async () => {
  const node = decoder({ iodd: '' })
  assert.equal(node.lastStatus.fill, 'red')
  const err = await node.receiveExpectingError({ payload: '092b0929' })
  assert.match(err.message, /no IODD configured/)
})

test('a file that is not an IODD is reported instead of crashing the runtime', () => {
  const node = decoder({ iodd: __filename })
  assert.equal(node.lastStatus.fill, 'red')
})

test('a missing file leaves the node red rather than throwing at deploy time', () => {
  const node = decoder({ iodd: '/nonexistent/device.xml' })
  assert.equal(node.lastStatus.fill, 'red')
})

test('data of the wrong length is reported with the IODD error code', async () => {
  const node = decoder({ strictLength: true })
  const err = await node.receiveExpectingError({ payload: '09' })
  assert.match(err.message, /^IODD_/, `expected a coded IODD error, got: ${err.message}`)
})
