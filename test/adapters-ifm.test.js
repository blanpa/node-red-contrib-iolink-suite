'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter, listProfiles, MasterError } = require('../lib/adapters')
const { FakeMaster } = require('./fake-master')

/** Every test gets its own master, so writes in one cannot leak into another. */
async function withMaster (fn) {
  const master = await new FakeMaster().listen()
  const adapter = createAdapter('ifm', { url: master.url, timeout: 2000 })
  try {
    await fn(adapter, master)
  } finally {
    await master.close()
  }
}

test('the registry lists the profiles and says what each rests on', () => {
  const profiles = listProfiles()
  assert.deepEqual(profiles.map(p => p.id), ['ifm', 'jsonapi', 'generic'])
  // None has been checked against a master yet, and the registry must not
  // claim otherwise: the dialog repeats what it says here.
  assert.ok(profiles.every(p => p.verified === false))
  assert.match(profiles.find(p => p.id === 'ifm').basis, /documentation/)
})

test('an unknown profile names the ones that exist', () => {
  assert.throws(() => createAdapter('siemens', {}), err => {
    assert.ok(err instanceof MasterError)
    assert.match(err.message, /unknown master profile "siemens"; available: ifm, jsonapi, generic/)
    return true
  })
})

test('a host and port build the IoT Core URL', () => {
  const adapter = createAdapter('ifm', { host: '192.168.1.250', httpPort: 8080 })
  assert.equal(adapter.baseUrl, 'http://192.168.1.250:8080/')
  assert.equal(createAdapter('ifm', { host: 'm.local', tls: true }).baseUrl, 'https://m.local/')
})

test('identify reports the master product and serial', async () => {
  await withMaster(async adapter => {
    const info = await adapter.identify()
    assert.equal(info.profile, 'ifm')
    assert.equal(info.product, 'AL1350')
    assert.equal(info.serial, '000123456789')
  })
})

test('process data input comes back as lower-case hex', async () => {
  await withMaster(async adapter => {
    // The master answers in upper case; every adapter normalises to lower.
    assert.equal(await adapter.readProcessDataIn(1), '092b0929')
  })
})

test('process data output is written upper-case and read back', async () => {
  await withMaster(async (adapter, master) => {
    assert.equal(await adapter.writeProcessDataOut(1, '7f'), true)
    assert.equal(master.state.ports[1].pdout, '7F')
    assert.equal(await adapter.readProcessDataOut(1), '7f')
  })
})

test('an ISDU read and write round-trips through index and subindex', async () => {
  await withMaster(async (adapter, master) => {
    assert.equal(await adapter.readIsdu(1, 100, 0), '092b')
    await adapter.writeIsdu(1, 100, 0, '1388')
    assert.equal(master.state.ports[1].isdu['100/0'], '1388')
    assert.equal(await adapter.readIsdu(1, 100), '1388')
  })
})

test('a device rejecting an ISDU index surfaces the IoT Core code, not HTTP 200', async () => {
  await withMaster(async adapter => {
    const e = await adapter.readIsdu(1, 999, 0).catch(e => e)
    assert.ok(e instanceof MasterError)
    assert.equal(e.ioTCoreCode, 801)
    assert.match(e.message, /rejected .* with code 801: index 999\/0 is not supported/)
  })
})

test('port status translates the numeric status into words', async () => {
  await withMaster(async adapter => {
    const status = await adapter.readPortStatus(1)
    assert.deepEqual(
      { connected: status.connected, operational: status.operational, statusText: status.statusText },
      { connected: true, operational: true, statusText: 'device connected (operate)' })
    assert.equal(status.modeText, 'IO-Link')
    assert.equal(status.processDataAvailable, true)

    const empty = await adapter.readPortStatus(2)
    assert.equal(empty.connected, false)
    assert.equal(empty.statusText, 'no device')
    assert.equal(empty.processDataAvailable, false)
  })
})

test('a scan reports identity only for ports that carry a device', async () => {
  await withMaster(async adapter => {
    const ports = await adapter.scanPorts([1, 2, 3])
    assert.equal(ports.length, 3)

    assert.deepEqual(
      { port: ports[0].port, vendorId: ports[0].vendorId, deviceId: ports[0].deviceId },
      { port: 1, vendorId: 999, deviceId: 4242 })
    assert.equal(ports[0].productName, 'DEMO-100')
    assert.equal(ports[0].serial, 'TI-0001')

    // An empty port is a normal result, so it must not carry a stale identity.
    assert.equal(ports[1].connected, false)
    assert.equal(ports[1].vendorId, undefined)
    // A port running as a digital input is not in IO-Link mode.
    assert.equal(ports[2].connected, false)
    assert.equal(ports[2].modeText, 'digital input (DI)')
  })
})

test('a scan falls back to the configured port list', async () => {
  const master = await new FakeMaster().listen()
  try {
    const adapter = createAdapter('ifm', { url: master.url, ports: [1, 2] })
    assert.deepEqual((await adapter.scanPorts()).map(p => p.port), [1, 2])
  } finally { await master.close() }
})

test('one port failing does not abort the scan of the others', async () => {
  const master = await new FakeMaster().listen()
  try {
    const adapter = createAdapter('ifm', { url: master.url })
    // Port 9 does not exist on this master and answers with code 400. The
    // master answered, so that is the port's state, not an outage.
    const ports = await adapter.scanPorts([9, 1])
    assert.equal(ports[0].connected, false)
    assert.match(ports[0].statusText, /port 9 does not exist/)
    assert.equal(ports[0].error, undefined)
    assert.equal(ports[1].vendorId, 999)
  } finally { await master.close() }
})

test('an unreachable master reports an error per port, not an empty rack', async () => {
  // A network outage and a master with nothing plugged in must not look alike:
  // an operator seeing "0 of 4 ports in use" would go looking at the wiring.
  const adapter = createAdapter('ifm', { url: 'http://127.0.0.1:1/', timeout: 1000 })
  const ports = await adapter.scanPorts([1, 2])
  for (const port of ports) {
    assert.match(port.error, /cannot reach/)
    assert.notEqual(port.connected, false, 'an unreachable port must not claim to be empty')
  }
})

test('every request carries a fresh cid', async () => {
  await withMaster(async (adapter, master) => {
    await adapter.readProcessDataIn(1)
    await adapter.readProcessDataIn(1)
    const cids = master.requests.map(r => r.cid)
    assert.equal(new Set(cids).size, cids.length, `cids repeated: ${cids}`)
  })
})

test('an unreachable master fails with a message naming the URL', async () => {
  const adapter = createAdapter('ifm', { url: 'http://127.0.0.1:1/', timeout: 1000 })
  const e = await adapter.readProcessDataIn(1).catch(e => e)
  assert.match(e.message, /cannot reach http:\/\/127\.0\.0\.1:1\//)
})
