'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd, encodeLayout, encodeDetailedDeviceStatus } = require('../lib/iodd')

/**
 * A stand-in for an ifm IoT Core master.
 *
 * The adapters are the part of this package that can only be proven against a
 * real master, which no CI runner has. This server speaks the same request and
 * reply envelope as the real thing - one POST endpoint, a `code` in the body
 * that is not the HTTP status - so the adapter, the nodes and a whole Node-RED
 * flow can be exercised end to end. It is deliberately literal about the
 * device's quirks: uppercase hex, codes 800/801 for a port with nothing on it.
 *
 * Out of the box the rack is fixed and the values never move, because that is
 * what a test wants. Port 1 carries the demo sensor from the test fixtures
 * (vendorId 999, deviceId 4242) and answers the standard diagnosis objects at
 * index 36 and 37. Port 2 is empty. Port 3 is a digital input, not IO-Link.
 *
 *   node test/fake-master.js                      # the fixed rack, on :8080
 *   node test/fake-master.js <plant.json>         # a rack you describe
 *
 * A plant file populates ports from real IODDs and lets the values move, so a
 * flow can be built and demonstrated without a master on the desk - see
 * test/fixtures/simulator-plant.json. While it runs, /sim answers what the
 * rack currently looks like and takes changes to it: pull a device, set a
 * device status, raise an event. See the control API at the bottom.
 */

const hex = text => Buffer.from(text, 'utf8').toString('hex').toUpperCase()

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const DEFAULT_STATE = () => ({
  product: 'AL1350',
  serial: '000123456789',
  ports: {
    1: {
      status: 2,
      mode: 1,
      vendorId: 999,
      deviceId: 4242,
      productName: 'DEMO-100',
      serial: 'TI-0001',
      pdin: '092B0929',
      pdout: '0B',
      isdu: {
        // index/subindex -> hex, as the master reports it
        '100/0': '092B', //   2347 -> 23.47 degC through the IODD's gradient
        '101/0': '01', //     enum: normally closed
        '102/0': hex('Line A'), //  a String parameter, shorter than its declared length
        '16/0': hex('Test Instruments GmbH'),
        // The two objects every device must have: DeviceStatus says
        // "maintenance required", DetailedDeviceStatus says why - qualifier E4
        // (appears, warning, from the device) and EventCode 8C40, "cleaning".
        // The second slot is empty, as a device with room to spare reports it.
        '36/0': '01',
        '37/0': 'E48C40000000'
      }
    },
    2: { status: 0, mode: 1 },
    3: { status: 0, mode: 2 }
  }
})

// --------------------------------------------------------------- moving values

/**
 * The shapes a simulated value can take, as a function of the clock.
 *
 * `phase` runs 0..1 over each period, so every wave is periodic and depends on
 * nothing but the time: two readings of the same instant agree, which is what
 * lets a test pin the clock and assert an exact reading.
 */
const WAVES = {
  constant: (phase, { value = 0 }) => value,
  ramp: (phase, { min = 0, max = 1 }) => min + (max - min) * phase,
  triangle: (phase, { min = 0, max = 1 }) =>
    min + (max - min) * (phase < 0.5 ? phase * 2 : 2 - phase * 2),
  sine: (phase, { min = 0, max = 1 }) =>
    min + (max - min) * (1 - Math.cos(2 * Math.PI * phase)) / 2,
  // Half the period high, half low - and with no bounds given, a plain toggle,
  // which is what a switching signal in the process data usually is.
  square: (phase, { min = false, max = true }) => (phase < 0.5 ? max : min),
  /**
   * A new value each period, drawn from a hash of the period number: random to
   * look at, identical on a re-run. A simulator that cannot reproduce what it
   * showed you an hour ago is hard to file a bug against.
   */
  random: (phase, spec, step) => {
    const { min = 0, max = 1, seed = 0 } = spec
    let h = Math.imul(step ^ seed, 0x45d9f3b) >>> 0
    h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f) >>> 0
    return min + (max - min) * ((h >>> 8) / 0xffffff)
  }
}

/** Evaluate one value specification at a point in time. */
function signal (spec, at) {
  if (typeof spec === 'number' || typeof spec === 'boolean' || typeof spec === 'string') {
    return spec
  }
  const wave = WAVES[spec.wave || 'constant']
  if (!wave) {
    throw new Error(`unknown wave "${spec.wave}"; have ${Object.keys(WAVES).join(', ')}`)
  }
  const period = Number(spec.periodMs) || 10000
  const shifted = at + (Number(spec.offsetMs) || 0)
  const step = Math.floor(shifted / period)
  const value = wave((shifted % period) / period, spec, step)
  if (typeof value !== 'number') return value
  const decimals = spec.decimals
  return decimals === undefined ? value : Number(value.toFixed(decimals))
}

// ---------------------------------------------------------------- plant files

/**
 * Read a plant description: which device sits on which port, what its values
 * are doing, and how it says it is feeling.
 *
 * A port names an IODD, and the simulator encodes the values through it. That
 * way the bytes on the wire are the bytes that IODD describes - including its
 * scaling - rather than a hex string somebody typed and nobody checked.
 */
function loadPlant (source, { baseDir = process.cwd() } = {}) {
  const config = typeof source === 'string'
    ? JSON.parse(fs.readFileSync(path.resolve(baseDir, source), 'utf8'))
    : source
  const dir = typeof source === 'string' ? path.dirname(path.resolve(baseDir, source)) : baseDir

  const state = {
    product: config.product || 'AL1350',
    serial: config.serial || '000123456789',
    ports: {}
  }
  for (const [number, spec] of Object.entries(config.ports || {})) {
    state.ports[number] = buildPort(spec, dir)
  }
  return state
}

function buildPort (spec, dir) {
  const port = {
    mode: spec.mode ?? 1,
    status: spec.status ?? (spec.connected === false ? 0 : 2),
    isdu: { ...(spec.isdu || {}) },
    pdout: spec.pdout || '00'
  }
  if (spec.iodd) {
    const device = parseIodd(fs.readFileSync(path.resolve(dir, spec.iodd), 'utf8'),
      spec.parse || {})
    port.device = device
    port.layout = device.layout('in', spec.parse || {})
    port.vendorId = device.identity.vendorId
    port.deviceId = device.identity.deviceId
    port.productName = spec.productName ||
      (device.identity.variants[0] || {}).productId || device.identity.deviceName
    port.serial = spec.serial || `SIM-${String(device.identity.deviceId).padStart(4, '0')}`
    port.values = spec.values || {}
  } else {
    Object.assign(port, {
      vendorId: spec.vendorId,
      deviceId: spec.deviceId,
      productName: spec.productName,
      serial: spec.serial,
      pdin: spec.pdin
    })
  }
  port.deviceStatus = spec.deviceStatus
  port.events = spec.events || []
  applyDiagnosis(port)
  return port
}

/**
 * Write the port's health into the objects a device reports it through, so the
 * rest of the server has one source of truth and the nodes read it the way
 * they would from real hardware.
 */
function applyDiagnosis (port) {
  if (port.deviceStatus === undefined && !port.events.length) return
  port.isdu = port.isdu || {}
  port.isdu['36/0'] = Number(port.deviceStatus || 0).toString(16).padStart(2, '0').toUpperCase()
  port.isdu['37/0'] = encodeDetailedDeviceStatus(port.events, { slots: Math.max(2, port.events.length) })
    .toString('hex').toUpperCase()
}

// -------------------------------------------------------------------- the master

class FakeMaster {
  /**
   * @param {object} [state]  a rack, from DEFAULT_STATE() or loadPlant()
   * @param {object} [options]
   * @param {Function} [options.now]  the clock, so a test can pin the time
   */
  constructor (state, options = {}) {
    this.state = state || DEFAULT_STATE()
    this.now = options.now || (() => Date.now())
    this.requests = []
    this.server = http.createServer((req, res) => this._handle(req, res))
  }

  /** Build a master from a plant file. */
  static fromPlant (file, options = {}) {
    return new FakeMaster(loadPlant(file, options), options)
  }

  async listen (port = 0, host = '127.0.0.1') {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, resolve)
    })
    this.port = this.server.address().port
    this.url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${this.port}/`
    return this
  }

  async close () {
    await new Promise(resolve => this.server.close(resolve))
  }

  /**
   * The process data input a port is currently producing.
   *
   * A simulated port encodes its values through the device's own IODD at the
   * moment it is asked; a fixed port just hands back the hex it was given.
   */
  processDataIn (port) {
    if (!port.layout) return port.pdin
    const at = this.now()
    const values = {}
    for (const [key, spec] of Object.entries(port.values || {})) {
      values[key] = signal(spec, at)
    }
    return encodeLayout(values, port.layout).toString('hex').toUpperCase()
  }

  _handle (req, res) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      // The control API sits beside the master's own endpoint, never inside it:
      // nothing a flow sends can reach it, and nothing the simulator adds
      // changes what the adapter sees.
      if (req.url.startsWith('/sim')) return this._control(req, res, body)

      let request
      try {
        request = JSON.parse(body || '{}')
      } catch {
        return send(res, 200, { code: 400, data: { message: 'malformed request' } })
      }
      this.requests.push(request)
      const reply = this.dispatch(request)
      // The IoT Core answers HTTP 200 even when it rejects the request; the
      // failure is in `code`. Anything else would hide masked errors.
      send(res, 200, { cid: request.cid, ...reply })
    })
  }

  dispatch ({ adr = '', data }) {
    const value = v => ({ code: 200, data: { value: v } })
    const ok = () => ({ code: 200 })
    const fail = (code, message) => ({ code, data: { message } })

    if (adr === '/deviceinfo/productcode/getdata') return value(this.state.product)
    if (adr === '/deviceinfo/serialnumber/getdata') return value(this.state.serial)

    const match = adr.match(/^\/iolinkmaster\/port\[(\d+)\]\/(.+)$/)
    if (!match) return fail(400, `unknown address ${adr}`)
    const port = this.state.ports[match[1]]
    const tail = match[2]
    if (!port) return fail(400, `port ${match[1]} does not exist on this master`)

    if (tail === 'mode/getdata') return value(String(port.mode))
    if (tail === 'iolinkdevice/status/getdata') return value(String(port.status))

    // Everything below needs a device in IO-Link mode.
    const connected = port.status === 1 || port.status === 2
    if (!connected) return fail(800, 'no device connected to this port')

    switch (tail) {
      case 'iolinkdevice/vendorid/getdata': return value(String(port.vendorId))
      case 'iolinkdevice/deviceid/getdata': return value(String(port.deviceId))
      case 'iolinkdevice/productname/getdata': return value(port.productName)
      case 'iolinkdevice/serial/getdata': return value(port.serial)
      case 'iolinkdevice/pdin/getdata': return value(this.processDataIn(port))
      case 'iolinkdevice/pdout/getdata': return value(port.pdout)
      case 'iolinkdevice/pdout/setdata':
        if (!data || typeof data.newvalue !== 'string') return fail(400, 'newvalue missing')
        if (data.newvalue.length % 2) return fail(400, 'odd-length hex')
        port.pdout = data.newvalue.toUpperCase()
        return ok()
      case 'iolinkdevice/iolreadacyclic': {
        const key = `${Number(data && data.index)}/${Number((data && data.subindex) || 0)}`
        const hit = (port.isdu || {})[key]
        if (hit === undefined) return fail(801, `index ${key} is not supported by the device`)
        return value(hit)
      }
      case 'iolinkdevice/iolwriteacyclic': {
        const key = `${Number(data && data.index)}/${Number((data && data.subindex) || 0)}`
        if (typeof data.value !== 'string') return fail(400, 'value missing')
        port.isdu = port.isdu || {}
        port.isdu[key] = data.value.toUpperCase()
        return ok()
      }
      default:
        return fail(400, `unknown address ${adr}`)
    }
  }

  // ------------------------------------------------------------- control API

  /** What the rack looks like right now, in plain terms. */
  describe () {
    const ports = {}
    for (const [number, port] of Object.entries(this.state.ports)) {
      ports[number] = {
        connected: port.status === 1 || port.status === 2,
        status: port.status,
        mode: port.mode,
        vendorId: port.vendorId,
        deviceId: port.deviceId,
        productName: port.productName,
        serial: port.serial,
        pdin: this.processDataIn(port),
        pdout: port.pdout,
        deviceStatus: port.deviceStatus,
        events: port.events,
        simulated: Boolean(port.layout),
        values: port.layout
          ? Object.fromEntries(Object.entries(port.values || {})
            .map(([key, spec]) => [key, signal(spec, this.now())]))
          : undefined
      }
    }
    return { product: this.state.product, serial: this.state.serial, ports }
  }

  /**
   * Change the rack while it runs: pull a device out, put one back, make a
   * sensor ask for maintenance. This is what turns the simulator from a fixture
   * into something you can demonstrate an alarm flow with.
   */
  patchPort (number, patch = {}) {
    const port = this.state.ports[number]
    if (!port) throw new Error(`port ${number} does not exist on this master`)
    if (patch.connected !== undefined) port.status = patch.connected ? 2 : 0
    if (patch.status !== undefined) port.status = Number(patch.status)
    if (patch.mode !== undefined) port.mode = Number(patch.mode)
    if (patch.pdin !== undefined) { port.pdin = patch.pdin; delete port.layout }
    if (patch.pdout !== undefined) port.pdout = String(patch.pdout).toUpperCase()
    if (patch.values !== undefined) port.values = { ...port.values, ...patch.values }
    if (patch.isdu !== undefined) port.isdu = { ...port.isdu, ...patch.isdu }
    if (patch.deviceStatus !== undefined) port.deviceStatus = Number(patch.deviceStatus)
    if (patch.events !== undefined) port.events = patch.events
    if (patch.deviceStatus !== undefined || patch.events !== undefined) applyDiagnosis(port)
    return this.describe().ports[number]
  }

  _control (req, res, body) {
    let patch = {}
    try {
      patch = body ? JSON.parse(body) : {}
    } catch {
      return send(res, 400, { error: 'the body is not JSON' })
    }
    const url = req.url.split('?')[0]
    try {
      if (req.method === 'GET' && url === '/sim') return send(res, 200, this.describe())
      const port = url.match(/^\/sim\/port\/(\d+)$/)
      if (req.method === 'POST' && port) {
        return send(res, 200, this.patchPort(port[1], patch))
      }
      return send(res, 404, {
        error: `no such control endpoint: ${req.method} ${url}`,
        endpoints: ['GET /sim', 'POST /sim/port/{n}']
      })
    } catch (e) {
      return send(res, 400, { error: e.message })
    }
  }
}

module.exports = { FakeMaster, DEFAULT_STATE, loadPlant, signal, WAVES }

if (require.main === module) {
  const plant = process.argv[2] || process.env.SIM_PLANT
  const port = Number(process.env.PORT) || 8080
  const master = plant ? FakeMaster.fromPlant(plant) : new FakeMaster()
  master.listen(port, '0.0.0.0').then(m => {
    const ports = Object.entries(m.state.ports)
      .filter(([, p]) => p.status > 0)
      .map(([n, p]) => `port ${n}: ${p.productName || 'device'}`)
    console.log(`fake ifm IoT Core master listening on :${m.port}` +
      (plant ? ` (${path.basename(plant)})` : '') +
      (ports.length ? ` - ${ports.join(', ')}` : ' - empty rack'))
    console.log('control it at GET /sim and POST /sim/port/{n}')
  })
}
