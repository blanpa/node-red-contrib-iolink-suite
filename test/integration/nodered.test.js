'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * The suite inside a real Node-RED.
 *
 * The unit tests stub the runtime; this one does not. It runs against the
 * official Node-RED image with the packed tarballs installed, the flow in
 * docker/flows.json deployed, and the fake ifm master on the other side. It is
 * the only test that can catch a node that unit-tests perfectly but never
 * appears in the palette: a bad `node-red` block, a file left out of
 * package.json, an editor html that fails to register.
 *
 *   docker compose -f docker-compose.test.yml run --rm --build integration
 */

const BASE = process.env.NODE_RED_URL || 'http://127.0.0.1:1880'

async function api (path, options = {}) {
  const res = await fetch(BASE + path, options)
  const text = await res.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* an HTML error page stays text */ }
  return { status: res.status, body }
}

test('Node-RED is up and reports its version', async () => {
  const { status, body } = await api('/settings')
  assert.equal(status, 200)
  assert.match(body.version, /^\d+\./)
})

test('every node of the suite is registered in the palette', async () => {
  const { body } = await api('/nodes', { headers: { Accept: 'application/json' } })
  const suite = body.filter(m => m.module === 'node-red-contrib-iolink-suite')
  assert.ok(suite.length, 'the module is not installed in Node-RED at all')

  const types = suite.flatMap(m => m.types)
  for (const type of ['iolink-master', 'iolink-read', 'iolink-write', 'iolink-param',
    'iolink-event', 'iolink-scan', 'iodd-decode']) {
    assert.ok(types.includes(type), `${type} is missing from the palette`)
  }
  // A node that failed to load is registered but not enabled, and Node-RED
  // says why in `err` - which is exactly the failure this test exists for.
  for (const set of suite) {
    assert.equal(set.err, undefined, `${set.id} failed to load: ${set.err}`)
    assert.equal(set.enabled, true, `${set.id} is not enabled`)
  }
})

test('the editor half of every node is served', async () => {
  const { status, body } = await api('/nodes', { headers: { Accept: 'text/html' } })
  assert.equal(status, 200)
  for (const type of ['iolink-master', 'iolink-read', 'iolink-write', 'iolink-param',
    'iolink-event', 'iolink-scan', 'iodd-decode']) {
    assert.ok(body.includes(`data-template-name="${type}"`) ||
              body.includes(`data-template-name='${type}'`),
    `${type} has no edit template in what the editor is served`)
  }
})

test('the node icons are served by the editor', async () => {
  // The icons live in a directory Node-RED only finds if the package shipped
  // it, and only where the registry looks: <module>/nodes/icons. Get that
  // wrong and nothing breaks - the URL answers 200 with Node-RED's own
  // fallback arrow, so asking for the icon is not enough to know it arrived.
  // The registry's own listing is: a module whose icons were never found is
  // in it with an empty array.
  const listing = await fetch(`${BASE}/icons`).then(r => r.json())
  const ours = listing['node-red-contrib-iolink-suite']
  assert.ok(ours, 'the suite is not in the icon listing at all')
  assert.ok(ours.length,
    'Node-RED found no icons for the suite - are they still in nodes/icons?')

  // Whatever the registry found is what the nodes get, so check all of it
  // rather than a list kept in step by hand: the unit suite already pins the
  // icons to the nodes that ask for them, and adding one here should not need
  // a test edit.
  for (const icon of ours) {
    const res = await fetch(`${BASE}/icons/node-red-contrib-iolink-suite/${icon}`)
    assert.equal(res.status, 200, `${icon} is not served`)
    const body = await res.text()
    assert.match(body, /<svg/, `${icon} came back as something other than an SVG`)
    // Ours is the black mark; every icon Node-RED falls back to is white.
    assert.match(body, /fill="#000"/, `${icon} came back as a stand-in, not ours`)
  }
})

test('the deployed flow is running', async () => {
  const { body } = await api('/flows', { headers: { Accept: 'application/json' } })
  const flows = Array.isArray(body) ? body : body.flows
  assert.ok(flows.some(n => n.type === 'iolink-master'), 'the master config node is not deployed')
  assert.ok(flows.some(n => n.type === 'iolink-read'), 'the read node is not deployed')
  // The event node polls the master on its own, device status and all. Nothing
  // triggers it, so if it were broken in a real runtime it would say so here.
  const event = flows.find(n => n.type === 'iolink-event')
  assert.ok(event, 'the event node is not deployed')
  assert.equal(event.deviceStatus, true)
})

test('a flow reads and decodes a port through the master', async () => {
  const { status, body } = await api('/read')
  assert.equal(status, 200, `read failed: ${JSON.stringify(body)}`)
  assert.deepEqual(body.payload, {
    Temperature: 23.47, Counter: 586, SwitchingSignal2: false, SwitchingSignal1: true
  })
  assert.equal(body.meta.Temperature.unit, '°C')
  assert.equal(body.device.product, 'DEMO-100')
  assert.equal(body.device.vendor, 'Test Instruments GmbH')
  assert.equal(body.iolink.raw, '092b0929')
})

test('the IODD is taken from the folder on disk, not from the network', async () => {
  // The master node is offline, so IODDfinder is not an option: the IODD can
  // only have come from /data/iodd, or from the store's memory once a previous
  // request put it there.
  const { body } = await api('/scan')
  const port1 = body.payload.find(p => p.port === 1)
  assert.ok(['file', 'memory'].includes(port1.iodd.source),
    `the IODD came from "${port1.iodd.source}", not from the folder on disk`)
  assert.equal(port1.iodd.productName, 'DEMO-100')
  assert.deepEqual(port1.iodd.warnings, [])
})

test('a scan reports the empty ports as empty', async () => {
  const { body } = await api('/scan')
  const ports = body.payload
  assert.deepEqual(ports.map(p => p.port), [1, 2, 3])
  assert.equal(ports.find(p => p.port === 2).connected, false)
})

test('a flow writes process data by name and merges the rest', async () => {
  const { status, body } = await api('/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Intensity: 9 })
  })
  assert.equal(status, 200, `write failed: ${JSON.stringify(body)}`)
  // The fake master starts at 0x0B (valve on, intensity 5); setting only the
  // intensity must leave the valve bit alone: 9 << 1 | 1 = 0x13.
  assert.equal(body.iolink.raw, '13')
  assert.equal(body.iolink.merged, true)
})

test('a flow reads an ISDU parameter by its name', async () => {
  const { status, body } = await api('/param')
  assert.equal(status, 200, `param read failed: ${JSON.stringify(body)}`)
  assert.equal(body.payload, 23.47)
  assert.equal(body.meta.unit, '°C')
  assert.equal(body.iolink.index, 100)
  assert.equal(body.iolink.parameter, 'Switch point')
})

test('split output arrives with the topic the flow configured', async () => {
  const { status, body } = await api('/split')
  assert.equal(status, 200, `split read failed: ${JSON.stringify(body)}`)
  assert.equal(body.topic, 'plant/line1/Temperature')
  assert.equal(body.payload, 23.47)
})

test('raw bytes from anywhere decode without a master', async () => {
  const { status, body } = await api('/decode?hex=092b0929')
  assert.equal(status, 200, `decode failed: ${JSON.stringify(body)}`)
  assert.equal(body.payload.Temperature, 23.47)
  assert.equal(body.device.vendorId, 999)
})

test('a decode of the wrong data reaches the flow as a catchable error', async () => {
  const { status, body } = await api('/decode?hex=zz')
  assert.equal(status, 500)
  assert.ok(body.error, 'the error should have reached the Catch node')
  // Node-RED puts the error's own toString() on the message, so the code the
  // node attached has to survive into it for a flow to branch on.
  assert.match(body.error, /IODD_DECODE/, `expected a coded IODD error, got: ${body.error}`)
})

test('the editor endpoints answer for a deployed master', async () => {
  // These are what the scan button and the value picker call.
  const scan = await api('/iolink-suite/scan/cfg-master')
  assert.equal(scan.status, 200, JSON.stringify(scan.body))
  assert.equal(scan.body[0].iodd.productName, 'DEMO-100')

  const datapoints = await api('/iolink-suite/datapoints/cfg-master/1')
  assert.equal(datapoints.status, 200, JSON.stringify(datapoints.body))
  assert.ok(datapoints.body.items.some(i => i.key === 'Temperature' && i.unit === '°C'))

  const parameters = await api('/iolink-suite/parameters/cfg-master/1')
  assert.equal(parameters.status, 200, JSON.stringify(parameters.body))
  assert.ok(parameters.body.parameters.some(p => p.index === 100 && p.name === 'Switch point'))
})

test('one read node reads several ports, keyed by port', async () => {
  // The rack here is the fixed one: a device on port 1, port 2 empty. That is
  // the more valuable case to run in a real runtime, because it exercises both
  // halves at once - the message is keyed by port because two ports were asked
  // for, and the port that had nothing on it is reported rather than lost.
  const { status, body } = await api('/read-many')
  assert.equal(status, 200, `multi read failed: ${JSON.stringify(body)}`)
  assert.deepEqual(Object.keys(body.payload), ['1'])
  assert.equal(body.payload[1].Temperature, 23.47)
  assert.equal(body.meta[1].Temperature.unit, '°C')
  assert.equal(body.device[1].port, 1)
  assert.equal(body.iolink[1].raw, '092b0929')
  assert.match(body.errors[2], /IOLINK_NO_DEVICE/,
    'the empty port should be named, not silently dropped')
})

test('one param node reads several parameters, keyed by name', async () => {
  const { body } = await api('/param-many')
  assert.deepEqual(Object.keys(body.payload).sort(), ['Output polarity', 'Switch point'])
  assert.equal(body.meta['Switch point'].unit, '°C')
  assert.equal(body.iolink['Switch point'].index, 100)
  // One device, so it stays where a single-parameter read puts it.
  assert.equal(body.device.port, 1)
})
