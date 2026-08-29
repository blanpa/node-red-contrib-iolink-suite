'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  PortIdentityCache, resolveDevice, readDeviceStatus, shapeOutput, splitOutput,
  fail, shorten, resolvePort, startPolling
} = require('../lib/runtime')
const { IoddStore } = require('../lib/iodd-store')
const { waitFor } = require('./helpers')

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
      vendorName: 'Test Instruments GmbH',
      vendorId: 999,
      deviceId: 4242,
      variants: [{ productId: 'DEMO-100' }],
      deviceName: 'Demo Temperature Sensor'
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
    vendor: 'Test Instruments GmbH',
    vendorId: 999,
    deviceId: 4242,
    product: 'DEMO-100',
    serial: 'TI-0001',
    port: 1
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

// ------------------------------------------------------------------ port input

/** Just enough of RED.util for the typed inputs the nodes offer. */
const RED = {
  util: {
    evaluateNodeProperty (value, type, node, msg) {
      if (type === 'msg') return value.split('.').reduce((a, k) => (a == null ? a : a[k]), msg)
      if (type === 'num') return Number(value)
      return value
    }
  }
}

test('a port typed into the node is used as it stands', () => {
  assert.equal(resolvePort(RED, {}, {}, { port: '3', portType: 'num' }), 3)
  assert.equal(resolvePort(RED, {}, {}, {}), 1, 'nothing configured means port 1')
})

test('a port taken from the message is read from the message', () => {
  const config = { port: 'port', portType: 'msg' }
  assert.equal(resolvePort(RED, {}, { port: 4 }, config), 4)
  assert.equal(resolvePort(RED, {}, { port: '4' }, config), 4)
})

/** assert.throws() hands back nothing, and these tests are about the error. */
const caught = fn => {
  try { fn() } catch (e) { return e }
  throw new Error('expected a failure, but the call returned')
}

test('a port the message does not carry is an error, not port 1', () => {
  // Falling back to port 1 would read a different sensor and report its values
  // as if they were the ones asked for - wrong data, no complaint.
  const e = caught(() => resolvePort(RED, {}, {}, { port: 'port', portType: 'msg' }))
  assert.equal(e.code, 'IOLINK_BAD_PORT')
  assert.match(e.message, /msg\.port/)
})

test('a port that is not a number at all is refused', () => {
  for (const value of ['left', '0', '-1', '1.5']) {
    const e = caught(() => resolvePort(RED, {}, {}, { port: value, portType: 'str' }))
    assert.equal(e.code, 'IOLINK_BAD_PORT', `"${value}" should not pass as a port`)
  }
})

// --------------------------------------------------------------------- polling

const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A node stub that records what a poller sends and reports. */
const pollNode = () => ({ sent: [], errors: [], send (m) { this.sent.push(m) }, error (e) { this.errors.push(e) } })

test('polling starts at once instead of one interval later', async () => {
  const node = pollNode()
  const stop = startPolling(node, 10000, async send => send('now'))
  await waitFor(() => node.sent.length > 0)
  stop()
  assert.deepEqual(node.sent, ['now'], 'the first reading must not wait for the first tick')
})

test('a tick is skipped rather than queued while one is still running', async () => {
  const node = pollNode()
  let running = 0
  let overlaps = 0
  const stop = startPolling(node, 5, async send => {
    if (running++) overlaps++
    await tick(40)
    running--
    send('done')
  })
  await tick(120)
  stop()
  assert.equal(overlaps, 0, 'a slow master must not build a backlog')
})

test('nothing is sent once the node is closed', async () => {
  const node = pollNode()
  let started = false
  const stop = startPolling(node, 10, async send => {
    started = true
    await tick(120)
    send('late')
  })
  await waitFor(() => started)
  stop()
  await tick(250)
  assert.deepEqual(node.sent, [], 'a stopped flow must not receive a message it never asked for')
  assert.deepEqual(node.errors, [])
})

test('a failing poll is reported on the node, since there is no message to fail', async () => {
  const node = pollNode()
  const stop = startPolling(node, 10, async () => { throw new Error('master says no') })
  await waitFor(() => node.errors.length > 0)
  stop()
  assert.ok(node.errors.includes('master says no'))
})

// ------------------------------------------------------------- device status

test('device status is read from the objects every device must have', async () => {
  const reads = []
  const adapter = {
    async readIsdu (port, index, subindex) {
      reads.push([port, index, subindex])
      return index === 36 ? '01' : 'E48C40'
    }
  }
  const status = await readDeviceStatus(adapter, 2)
  assert.deepEqual(reads, [[2, 36, 0], [2, 37, 0]])
  assert.equal(status.deviceStatus, 1)
  assert.equal(status.deviceStatusText, 'Maintenance required')
  assert.equal(status.deviceEvents[0].name, 'Maintenance required - Cleaning')
})

test('a device that answers 36 but refuses 37 still reports its status', async () => {
  // The detailed object is the one devices most often leave out; losing the
  // overall status because of it would throw away the useful half.
  const adapter = {
    async readIsdu (port, index) {
      if (index === 37) throw new Error('index not supported')
      return '04'
    }
  }
  const status = await readDeviceStatus(adapter, 1)
  assert.equal(status.deviceStatusText, 'Failure')
  assert.equal(status.deviceEvents, undefined)
})

// ------------------------------------------------------------------ port lists

test('a port list is read from every shape one actually arrives in', () => {
  const { parsePorts } = require('../lib/runtime')
  assert.deepEqual(parsePorts('1,2,3'), [1, 2, 3])
  assert.deepEqual(parsePorts(' 1, 2 ,4 '), [1, 2, 4])
  assert.deepEqual(parsePorts([1, 2]), [1, 2])
  assert.deepEqual(parsePorts(['1', '2']), [1, 2])
  assert.deepEqual(parsePorts(3), [3])
  assert.equal(parsePorts(''), undefined, 'nothing configured means every port')
  assert.equal(parsePorts(undefined), undefined)
})

test('a port list that holds no port is an error, not an empty scan', () => {
  const { parsePorts } = require('../lib/runtime')
  // Falling back to every port would hide the typo; scanning none would too.
  for (const bad of ['port one', 'a,b', ['x'], 0, -1]) {
    assert.throws(() => parsePorts(bad), e => e.code === 'IOLINK_BAD_PORT',
      `${JSON.stringify(bad)} should be refused`)
  }
})

// ------------------------------------------------------------------ serialiser

test('a serialiser runs tasks one after another, in order', async () => {
  const { serialiser } = require('../lib/runtime')
  const run = serialiser()
  const order = []
  let active = 0
  let overlapped = false

  const task = name => async () => {
    if (++active > 1) overlapped = true
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push(name)
    active--
  }

  await Promise.all([run(task('a')), run(task('b')), run(task('c'))])
  assert.equal(overlapped, false)
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('one failed task does not stop the ones behind it', async () => {
  const { serialiser } = require('../lib/runtime')
  const run = serialiser()
  const done = []

  const failing = run(async () => { throw new Error('nope') })
  const after = run(async () => { done.push('ran') })

  await assert.rejects(failing, /nope/)
  await after
  assert.deepEqual(done, ['ran'], 'a poll must not be wedged by the one before it')
})
