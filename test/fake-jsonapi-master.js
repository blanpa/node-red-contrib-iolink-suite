'use strict'
const { FakeMaster, DEFAULT_STATE } = require('./fake-master')

/**
 * A stand-in for a master speaking the IO-Link Community's JSON API
 * (JSON Integration for IO-Link, 10.222 V1.0.0).
 *
 * The same rack as the ifm stand-in - port 1 carries the demo sensor, port 2
 * is empty, port 3 is a digital input - behind the other interface: REST
 * paths under /iolink/v1, byte arrays instead of hex strings, HTTP status
 * codes that mean what they say, and the specification's own error objects.
 * Port 1 is renamed to `Demo_Sensor` so the alias lookup has something to
 * find; the other ports keep the default `master1portN` names.
 *
 * Built from the specification, like the adapter it tests. What a real
 * Balluff or Pepperl+Fuchs master answers is for scripts/record-master.js to
 * find out.
 */
class FakeJsonMaster extends FakeMaster {
  constructor (state, options = {}) {
    super(state || DEFAULT_STATE(), options)
    this.aliases = options.aliases || { 1: 'Demo_Sensor' }
    this.masterNumber = options.masterNumber || 1
  }

  aliasOf (number) {
    return this.aliases[number] || `master${this.masterNumber}port${number}`
  }

  portByAlias (alias) {
    for (const number of Object.keys(this.state.ports)) {
      if (this.aliasOf(number) === alias) return { number: Number(number), port: this.state.ports[number] }
    }
    return null
  }

  statusInfo (port) {
    if (port.mode === 0) return 'DEACTIVATED'
    if (port.mode === 2) return 'DIGITAL_INPUT_C/Q'
    if (port.mode === 3) return 'DIGITAL_OUTPUT_C/Q'
    if (port.status === 2) return 'DEVICE_ONLINE'
    if (port.status === 1) return 'DEVICE_STARTING'
    if (port.status === 3) return 'INCORRECT_DEVICE'
    if (port.status === 4) return 'COMMUNICATION_LOST'
    return 'NOT_AVAILABLE'
  }

  _handle (req, res) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.url.startsWith('/sim')) return this._control(req, res, body)
      const url = new URL(req.url, 'http://x')
      let data
      try {
        data = body ? JSON.parse(body) : undefined
      } catch {
        return this._error(res, 400, 201, 'JSON parsing failed')
      }
      this.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: data })
      this.dispatchJson(req.method, url, data, res)
    })
  }

  _error (res, status, code, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code, message }))
  }

  _json (res, value) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }

  _noContent (res) {
    res.writeHead(204)
    res.end()
  }

  dispatchJson (method, url, data, res) {
    const path = url.pathname
    const m = this.masterNumber
    const prefix = '/iolink/v1'
    if (!path.startsWith(prefix)) return this._error(res, 404, 301, 'Resource not found')
    const rest = path.slice(prefix.length)

    if (rest === `/masters/${m}/identification`) {
      return this._json(res, {
        vendorName: 'Fake Vendor',
        vendorId: 999,
        masterId: 1,
        masterType: 'Master acc. V1.1',
        productName: this.state.product,
        serialNumber: this.state.serial
      })
    }
    if (rest === `/masters/${m}/ports`) {
      return this._json(res, Object.entries(this.state.ports).map(([number, port]) => ({
        portNumber: Number(number),
        statusInfo: this.statusInfo(port),
        deviceAlias: this.aliasOf(number)
      })))
    }
    const portMatch = rest.match(new RegExp(`^/masters/${m}/ports/(\\d+)/status$`))
    if (portMatch) {
      const port = this.state.ports[portMatch[1]]
      if (!port) return this._error(res, 404, 303, 'portNumber not found')
      const info = this.statusInfo(port)
      const out = { statusInfo: info }
      if (info === 'DEVICE_ONLINE' || info === 'DEVICE_STARTING') {
        Object.assign(out, { ioLinkRevision: '1.1', transmissionRate: 'COM2', masterCycleTime: { value: 2.3, unit: 'ms' } })
      }
      return this._json(res, out)
    }
    if (rest.startsWith('/masters/')) return this._error(res, 404, 302, 'masterNumber not found')

    const deviceMatch = rest.match(/^\/devices\/([^/]+)(\/.*)$/)
    if (!deviceMatch) return this._error(res, 404, 301, 'Resource not found')
    const found = this.portByAlias(decodeURIComponent(deviceMatch[1]))
    if (!found) return this._error(res, 404, 304, 'deviceAlias not found')
    const { port } = found
    const tail = deviceMatch[2]
    const info = this.statusInfo(port)
    if (info === 'DIGITAL_INPUT_C/Q' || info === 'DIGITAL_OUTPUT_C/Q' || info === 'DEACTIVATED') {
      return this._error(res, 400, 307, 'Port is not configured to IO-Link')
    }
    if (info !== 'DEVICE_ONLINE' && info !== 'DEVICE_STARTING') {
      return this._error(res, 404, 308, 'IO-Link Device is not accessible')
    }
    const bytes = hex => Array.from(Buffer.from(hex || '', 'hex'))
    const toHex = arr => Buffer.from(arr).toString('hex').toUpperCase()

    if (tail === '/identification') {
      return this._json(res, {
        vendorId: port.vendorId,
        deviceId: port.deviceId,
        ioLinkRevision: '1.1',
        vendorName: 'Test Instruments GmbH',
        productName: port.productName,
        serialNumber: port.serial
      })
    }
    if (tail === '/processdata/getdata/value') {
      return this._json(res, { ioLink: { valid: !port.invalid, value: bytes(this.processDataIn(port)) } })
    }
    if (tail === '/processdata/setdata/value') {
      return this._json(res, { ioLink: { valid: true, value: bytes(port.pdout) } })
    }
    if (tail === '/processdata/value' && method === 'POST') {
      if (!data || !data.ioLink || !Array.isArray(data.ioLink.value)) {
        return this._error(res, 400, 203, 'JSON data type invalid')
      }
      port.pdout = toHex(data.ioLink.value)
      return this._noContent(res)
    }
    const param = tail.match(/^\/parameters\/(\d+)(?:\/subindices\/(\d+))?\/value$/)
    if (param) {
      const key = `${Number(param[1])}/${Number(param[2] || 0)}`
      port.isdu = port.isdu || {}
      if (method === 'POST') {
        if (!Array.isArray(data)) return this._error(res, 400, 203, 'JSON data type invalid')
        port.isdu[key] = toHex(data)
        return this._noContent(res)
      }
      const hit = port.isdu[key]
      if (hit === undefined) {
        return this._error(res, 400, 311, 'IO-Link parameter access error')
      }
      return this._json(res, bytes(hit))
    }
    return this._error(res, 404, 103, 'Operation not supported')
  }
}

module.exports = { FakeJsonMaster }

if (require.main === module) {
  new FakeJsonMaster().listen(Number(process.env.PORT) || 8081, '0.0.0.0')
    .then(m => console.log(`fake JSON API master on ${m.url}iolink/v1`))
}
