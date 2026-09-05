'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createAdapter, MasterError } = require('../lib/adapters')

/**
 * A REST master of the shape the generic profile targets: one path per
 * operation, the value nested somewhere in the reply.
 */
async function restMaster () {
  const calls = []
  const state = { pdout: '00' }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      calls.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : undefined })
      const reply = value => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ result: { value } }))
      }
      if (url.pathname === '/iolink/port/1/pdin') return reply('AB CD')
      if (url.pathname === '/iolink/port/1/pdout') {
        if (req.method === 'POST') { state.pdout = JSON.parse(body).value; return reply(true) }
        return reply(state.pdout)
      }
      if (url.pathname.startsWith('/iolink/port/1/isdu/')) {
        return reply(req.method === 'POST' ? true : '0x1234')
      }
      if (url.pathname === '/iolink/port/1/status') return reply(true)
      if (url.pathname === '/iolink/port/2/status') return reply(false)
      if (url.pathname === '/iolink/port/1/vendorid') return reply('999')
      if (url.pathname === '/iolink/port/1/deviceid') return reply('0x1092')
      if (url.pathname === '/iolink/port/1/productname') return reply('DEMO-100')
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

const adapterFor = master =>
  createAdapter('generic', { url: master.url, valuePath: 'result.value', timeout: 2000 })

test('a host without an explicit URL is turned into one', () => {
  assert.equal(createAdapter('generic', { host: '10.0.0.9', httpPort: 8080 }).baseUrl,
    'http://10.0.0.9:8080')
  assert.equal(createAdapter('generic', { host: '10.0.0.9', tls: true }).baseUrl, 'https://10.0.0.9')
  // A trailing slash in the configured URL must not double up in every path.
  assert.equal(createAdapter('generic', { url: 'http://m/api/' }).baseUrl, 'http://m/api')
})

test('reads and writes go to the default paths', async () => {
  const master = await restMaster()
  try {
    const adapter = adapterFor(master)
    // Separators and 0x prefixes are how these APIs really answer.
    assert.equal(await adapter.readProcessDataIn(1), 'abcd')
    assert.equal(await adapter.readIsdu(1, 100, 0), '1234')

    await adapter.writeProcessDataOut(1, '7f')
    assert.equal(master.state.pdout, '7f')

    await adapter.writeIsdu(1, 100, 2, '00ff')
    const write = master.calls.at(-1)
    assert.equal(write.method, 'POST')
    assert.equal(write.path, '/iolink/port/1/isdu/100/2')
    assert.deepEqual(write.body, { index: 100, subindex: 2, value: '00ff' })
  } finally { await master.close() }
})

test('the value is dug out of the configured path in the reply', async () => {
  const master = await restMaster()
  try {
    // Pointed at a key that does not exist, the adapter must return nothing
    // rather than an object that would later decode into nonsense.
    const adapter = createAdapter('generic', { url: master.url, valuePath: 'data.value' })
    assert.equal(await adapter.readProcessDataIn(1), null)
  } finally { await master.close() }
})

test('custom paths and methods replace the defaults', async () => {
  const master = await restMaster()
  try {
    const adapter = createAdapter('generic', {
      url: master.url,
      valuePath: 'result.value',
      paths: { readProcessDataIn: 'GET /iolink/port/{port}/pdin' }
    })
    assert.equal(await adapter.readProcessDataIn(1), 'abcd')
    // Overriding one path must leave the others in place.
    assert.equal(await adapter.readIsdu(1, 100), '1234')
  } finally { await master.close() }
})

test('an operation with no configured path says so instead of guessing', async () => {
  const adapter = createAdapter('generic', { url: 'http://127.0.0.1:1', paths: { readIsdu: null } })
  const e = await adapter.readIsdu(1, 100).catch(e => e)
  assert.ok(e instanceof MasterError)
  assert.match(e.message, /no path configured for readIsdu\(\)/)
})

test('a path template missing a variable is reported before the request goes out', async () => {
  const adapter = createAdapter('generic', {
    url: 'http://127.0.0.1:1',
    paths: { readProcessDataIn: 'GET /port/{port}/{channel}/pdin' }
  })
  const e = await adapter.readProcessDataIn(1).catch(e => e)
  assert.match(e.message, /needs \{channel\} but it was not supplied/)
})

test('path variables are URL-encoded', async () => {
  const master = await restMaster()
  try {
    const adapter = adapterFor(master)
    await adapter.readProcessDataIn('1/../2').catch(() => {})
    assert.equal(master.calls.at(-1).path, '/iolink/port/1%2F..%2F2/pdin')
  } finally { await master.close() }
})

test('a scan maps port status onto the common shape', async () => {
  const master = await restMaster()
  try {
    const adapter = adapterFor(master)
    const ports = await adapter.scanPorts([1, 2])
    assert.deepEqual(ports.map(p => ({ port: p.port, connected: p.connected })),
      [{ port: 1, connected: true }, { port: 2, connected: false }])
  } finally { await master.close() }
})

test('identifying a generic master actually reaches it', async () => {
  // The editor's connection test runs this. Reporting success without sending
  // anything would turn a wrong host into a green tick.
  const master = await restMaster()
  try {
    const adapter = createAdapter('generic',
      { url: master.url, valuePath: 'result.value', timeout: 2000, ports: [1, 2] })
    const info = await adapter.identify()
    assert.deepEqual(master.calls.map(c => c.path), ['/iolink/port/1/status'],
      'with no identify path it should probe the first configured port, once')
    assert.equal(info.probedPort, 1)
    assert.equal(info.profile, 'generic')
  } finally { await master.close() }
})

test('a generic master that cannot be reached fails the connection test', async () => {
  const adapter = createAdapter('generic',
    { url: 'http://127.0.0.1:1', timeout: 1000, valuePath: 'result.value' })
  await assert.rejects(adapter.identify(), e => e instanceof MasterError && /cannot reach/.test(e.message))
})

test('a generic master with nothing to ask says so rather than claiming success', async () => {
  const adapter = createAdapter('generic',
    { url: 'http://127.0.0.1:1', paths: { readPortStatus: null }, timeout: 1000 })
  await assert.rejects(adapter.identify(), /nothing to test the connection with/)
})

/**
 * Without a vendor and device id there is no IODD, and without an IODD the
 * read, write and parameter nodes have nothing to decode against - so this is
 * what makes the generic profile usable for more than raw hex.
 */
test('a generic scan reports who is on the port', async () => {
  const master = await restMaster()
  try {
    const [one, two] = await adapterFor(master).scanPorts([1, 2])
    assert.equal(one.connected, true)
    assert.equal(one.vendorId, 999)
    assert.equal(one.deviceId, 0x1092, 'an id written in hex is read as one')
    assert.equal(one.productName, 'DEMO-100')
    assert.equal(two.connected, false)
    assert.equal(two.vendorId, undefined, 'an empty port is not interrogated')
  } finally { await master.close() }
})

test('a master that does not answer an identity path is asked once, not every scan', async () => {
  // The default paths are a guess at the shape. On a master that spells them
  // differently, repeating four 404s per port per poll would be the event
  // node's steady state.
  const master = await restMaster()
  try {
    const adapter = createAdapter('generic', {
      url: master.url,
      valuePath: 'result.value',
      timeout: 2000,
      // Not answered by the stub master, so every request 404s.
      paths: { readVendorId: 'GET /nope/{port}' }
    })
    for (let i = 0; i < 4; i++) await adapter.scanPorts([1])
    const tries = master.calls.filter(c => c.path.startsWith('/nope')).length
    assert.equal(tries, 1, 'a refused path should be dropped, not retried')
    // The ones that do work must keep working.
    const [one] = await adapter.scanPorts([1])
    assert.equal(one.deviceId, 0x1092)
  } finally { await master.close() }
})

test('a master that is merely unreachable keeps being asked', async () => {
  // A refusal is about the path; a connection failure says nothing about it,
  // so a master that comes back must be identified again.
  const adapter = createAdapter('generic',
    { url: 'http://127.0.0.1:1', timeout: 500, valuePath: 'result.value' })
  await adapter._readIdentity(1)
  assert.equal(adapter.unsupported.size, 0)
})
