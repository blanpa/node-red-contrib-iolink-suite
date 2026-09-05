'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { FakeMaster, DEFAULT_STATE, loadPlant, signal } = require('./fake-master')
const { createAdapter } = require('../lib/adapters')
const { parseIodd } = require('../lib/iodd')
const fs = require('node:fs')

/**
 * The simulator itself.
 *
 * Every other test in this suite believes what this server says, so what it
 * says has to be right: bytes that match the IODD they claim to come from,
 * values that move the way the plant file describes, and a rack that can be
 * changed while it runs.
 */

const PLANT = path.join(__dirname, 'fixtures', 'simulator-plant.json')
const demo = () => parseIodd(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-sensor.iodd.xml'), 'utf8'))

/** A master with a clock the test moves by hand. */
function pinned (at = 0) {
  let now = at
  const master = new FakeMaster(loadPlant(PLANT), { now: () => now })
  return { master, advance: ms => { now += ms } }
}

test('the fixed rack is untouched by all of this', () => {
  // Every other test file leans on these exact values.
  const state = DEFAULT_STATE()
  assert.equal(state.ports[1].pdin, '092B0929')
  assert.equal(state.ports[1].isdu['36/0'], '01')
  assert.equal(new FakeMaster().processDataIn(state.ports[1]), '092B0929')
})

test('a plant file fills the ports from real IODDs', () => {
  const state = loadPlant(PLANT)
  assert.equal(state.ports[1].vendorId, 999)
  assert.equal(state.ports[1].deviceId, 4242)
  assert.equal(state.ports[1].productName, 'DEMO-100')
  assert.equal(state.ports[3].status, 0, 'a port declared unconnected stays empty')
  assert.equal(state.ports[4].mode, 2)
})

test('the process data is encoded through the device IODD, not typed by hand', () => {
  const { master } = pinned(15000) // a quarter into the 60 s temperature period
  const raw = master.processDataIn(master.state.ports[1])
  // Decoding the simulator's own bytes with the same IODD must give the values
  // the plant file asked for. If the encoder and the decoder ever disagree,
  // this is where it shows.
  const { payload } = demo().decodeIn(raw)
  assert.equal(payload.Temperature, signal(
    { wave: 'sine', min: 18.5, max: 24.5, periodMs: 60000, decimals: 2 }, 15000))
  assert.ok(payload.Temperature > 18.5 && payload.Temperature < 24.5)
  assert.equal(payload.SwitchingSignal2, false)
})

test('the values move with the clock, and repeat exactly', () => {
  const { master, advance } = pinned(0)
  const at = () => demo().decodeIn(master.processDataIn(master.state.ports[1])).payload

  const start = at()
  advance(15000)
  const quarter = at()
  assert.notEqual(quarter.Temperature, start.Temperature, 'the sine should have moved')
  assert.ok(quarter.Counter > start.Counter, 'the ramp should have climbed')

  // A full period later everything is back where it started: a simulator you
  // cannot replay is hard to file a bug against.
  advance(120000 - 15000)
  assert.deepEqual(at(), start)
})

test('a square wave without bounds is a plain toggle', () => {
  assert.equal(signal({ wave: 'square', periodMs: 1000 }, 0), true)
  assert.equal(signal({ wave: 'square', periodMs: 1000 }, 600), false)
})

test('random values are random-looking but reproducible', () => {
  const spec = { wave: 'random', min: 0, max: 100, periodMs: 1000, seed: 7 }
  const run = t => signal(spec, t)
  assert.equal(run(1500), run(1500), 'the same instant must give the same reading')
  assert.notEqual(run(1500), run(2500), 'a new period must give a new reading')
  for (const t of [0, 1000, 2000, 3000, 4000]) {
    assert.ok(run(t) >= 0 && run(t) <= 100)
  }
})

test('an unknown wave says so instead of quietly reading zero', () => {
  assert.throws(() => signal({ wave: 'zigzag' }, 0), /unknown wave "zigzag"/)
})

test('device health from the plant file arrives as the standard ISDU objects', async () => {
  const { master } = pinned(0)
  await master.listen()
  try {
    const adapter = createAdapter('ifm', { url: master.url })
    assert.equal(await adapter.readIsdu(2, 36, 0), '01')
    // The port declares one event, in a device that has room for two.
    assert.equal(await adapter.readIsdu(2, 37, 0), 'e48c40000000')
  } finally { await master.close() }
})

test('the rack can be changed while it runs', async () => {
  const { master } = pinned(0)
  await master.listen()
  try {
    const adapter = createAdapter('ifm', { url: master.url })
    const post = (path, body) => fetch(master.url.replace(/\/$/, '') + path,
      { method: 'POST', body: JSON.stringify(body) }).then(r => r.json())

    // Pull the device on port 1 out.
    let [port1] = await adapter.scanPorts([1])
    assert.equal(port1.connected, true)
    await post('/sim/port/1', { connected: false })
    ;[port1] = await adapter.scanPorts([1])
    assert.equal(port1.connected, false, 'the flow should see the device disappear')

    // Plug it back in and make it ask for maintenance.
    await post('/sim/port/1', { connected: true, deviceStatus: 2, events: ['0x8C10', '0x5112'] })
    ;[port1] = await adapter.scanPorts([1])
    assert.equal(port1.connected, true)
    assert.equal(await adapter.readIsdu(1, 36, 0), '02')
    const detail = await adapter.readIsdu(1, 37, 0)
    assert.match(detail, /8c10/, 'the raised events should be in DetailedDeviceStatus')
    assert.match(detail, /5112/)
  } finally { await master.close() }
})

test('a value can be pinned from outside, for a scripted demonstration', async () => {
  const { master } = pinned(0)
  await master.listen()
  try {
    await fetch(master.url.replace(/\/$/, '') + '/sim/port/1',
      { method: 'POST', body: JSON.stringify({ values: { Temperature: 42.5 } }) })
    const adapter = createAdapter('ifm', { url: master.url })
    const { payload } = demo().decodeIn(await adapter.readProcessDataIn(1))
    assert.equal(payload.Temperature, 42.5)
    // The values that were not mentioned keep running.
    assert.equal(typeof payload.Counter, 'number')
  } finally { await master.close() }
})

test('the control API reports the whole rack', async () => {
  const { master } = pinned(0)
  await master.listen()
  try {
    const state = await fetch(master.url.replace(/\/$/, '') + '/sim').then(r => r.json())
    assert.equal(state.ports[1].connected, true)
    assert.equal(state.ports[1].simulated, true)
    assert.equal(state.ports[3].connected, false)
    assert.equal(typeof state.ports[1].values.Temperature, 'number')
  } finally { await master.close() }
})

test('the control API refuses what it does not understand', async () => {
  const { master } = pinned(0)
  await master.listen()
  try {
    const base = master.url.replace(/\/$/, '')
    const bad = await fetch(base + '/sim/nope', { method: 'POST', body: '{}' })
    assert.equal(bad.status, 404)
    const missing = await fetch(base + '/sim/port/9', { method: 'POST', body: '{}' })
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /port 9 does not exist/)
  } finally { await master.close() }
})

test('nothing a flow sends can reach the control API', async () => {
  const { master } = pinned(0)
  await master.listen()
  try {
    // The master's own endpoint is POST /, and its addresses are strings in the
    // body - there is no path a node could put "/sim" into.
    const adapter = createAdapter('ifm', { url: master.url })
    await assert.rejects(() => adapter.readIsdu(1, 999, 0), /not supported by the device/)
    const state = await fetch(master.url.replace(/\/$/, '') + '/sim').then(r => r.json())
    assert.equal(state.ports[1].connected, true)
  } finally { await master.close() }
})
