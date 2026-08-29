'use strict'
const { MasterAdapter, MasterError, toHex } = require('./base')
const { requestJson } = require('../http')

/**
 * Generic HTTP/JSON master.
 *
 * Balluff, Turck and others all expose REST/JSON APIs of the same shape as
 * ifm's - different paths, same idea. Rather than ship guesses at endpoints
 * that cannot be tested without the hardware, this profile lets the paths and
 * the response field be configured, so a new master is a configuration entry
 * rather than a code change, and a working configuration can be contributed
 * back as a preset.
 *
 * Templates use {port}, {index}, {subindex} and {value}.
 */
class GenericAdapter extends MasterAdapter {
  static get label () { return 'Generic HTTP/JSON' }

  constructor (config) {
    super(config)
    const scheme = config.tls ? 'https' : 'http'
    const httpPort = config.httpPort ? `:${config.httpPort}` : ''
    this.baseUrl = (config.url || `${scheme}://${config.host}${httpPort}`).replace(/\/+$/, '')
    this.auth = config.user ? { user: config.user, password: config.password } : undefined
    this.fetchImpl = config.fetchImpl
    this.paths = { ...DEFAULT_PATHS, ...(config.paths || {}) }
    // Dotted path to the payload inside the reply, e.g. "data.value".
    this.valuePath = config.valuePath || 'value'
    // Identity paths this master has refused. The defaults are a guess at the
    // shape, so on a master that spells them differently every scan would
    // otherwise repeat four requests it already knows will 404.
    this.unsupported = new Set()
  }

  _expand (template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      if (vars[key] === undefined) {
        throw new MasterError(`path template needs {${key}} but it was not supplied`,
          { template, key })
      }
      return encodeURIComponent(String(vars[key]))
    })
  }

  async _call (name, vars, body) {
    const spec = this.paths[name]
    if (!spec) {
      throw new MasterError(`this master profile has no path configured for ${name}()`,
        { operation: name })
    }
    const [method, template] = spec.includes(' ') ? spec.split(/\s+/, 2) : ['GET', spec]
    const url = this.baseUrl + this._expand(template, vars)
    const reply = await requestJson(url, {
      method,
      body,
      timeout: this.timeout,
      auth: this.auth,
      fetchImpl: this.fetchImpl
    })
    return this.valuePath
      ? this.valuePath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), reply)
      : reply
  }

  /**
   * Say who is at the other end - and, above all, prove there is one.
   *
   * Most masters of this shape have no identification endpoint worth
   * configuring, so without an `identify` path this asks a port for its status
   * instead. Answering "reached" without having sent anything would make the
   * editor's connection test green for a host that does not exist, which is
   * worse than having no test at all.
   */
  async identify () {
    if (this.paths.identify) {
      return { profile: 'generic', url: this.baseUrl, info: await this._call('identify', {}) }
    }
    if (!this.paths.readPortStatus) {
      throw new MasterError(
        'this master has neither an identify nor a readPortStatus path, so there ' +
        'is nothing to test the connection with',
        { url: this.baseUrl })
    }
    const port = (this.config.ports || [1])[0]
    await this._call('readPortStatus', { port })
    return { profile: 'generic', url: this.baseUrl, probedPort: Number(port) }
  }

  async readProcessDataIn (port) {
    return toHex(await this._call('readProcessDataIn', { port }))
  }

  async readProcessDataOut (port) {
    return toHex(await this._call('readProcessDataOut', { port }))
  }

  async writeProcessDataOut (port, hex) {
    await this._call('writeProcessDataOut', { port, value: hex }, { value: hex })
    return true
  }

  async readIsdu (port, index, subindex = 0) {
    return toHex(await this._call('readIsdu', { port, index, subindex }))
  }

  async writeIsdu (port, index, subindex = 0, hex) {
    await this._call('writeIsdu', { port, index, subindex, value: hex },
      { index, subindex, value: hex })
    return true
  }

  async readPortStatus (port) {
    if (!this.paths.readPortStatus) return { port: Number(port), connected: null }
    const value = await this._call('readPortStatus', { port })
    return { port: Number(port), connected: Boolean(value), status: value }
  }

  /**
   * Who is on a port: what turns "something is plugged in" into "a DEMO-100 is
   * plugged in", and so into an IODD.
   *
   * Masters of this shape put each of these behind its own path, so each is
   * asked for separately and each is optional. A master that reports no vendor
   * and device id cannot have its IODD looked up automatically at all - the
   * read, write and parameter nodes then need the ids pinned in their own
   * configuration, and say so.
   */
  async _readIdentity (port) {
    const ask = async name => {
      if (!this.paths[name] || this.unsupported.has(name)) return undefined
      try {
        return await this._call(name, { port })
      } catch (e) {
        // A refusal is about the path, so stop asking. A master that could not
        // be reached at all says nothing about the path, so keep asking.
        if (e.status >= 400) this.unsupported.add(name)
        return undefined
      }
    }
    const [vendorId, deviceId, productName, serial] = await Promise.all([
      ask('readVendorId'), ask('readDeviceId'), ask('readProductName'), ask('readSerial')
    ])
    const out = {}
    if (toId(vendorId) !== undefined) out.vendorId = toId(vendorId)
    if (toId(deviceId) !== undefined) out.deviceId = toId(deviceId)
    if (productName !== undefined && productName !== null) out.productName = String(productName)
    if (serial !== undefined && serial !== null) out.serial = String(serial)
    return out
  }

  async scanPorts (ports) {
    const list = ports || this.config.ports || [1, 2, 3, 4, 5, 6, 7, 8]
    const out = []
    for (const port of list) {
      try {
        const entry = { ...(await this.readPortStatus(port)) }
        if (entry.connected) Object.assign(entry, await this._readIdentity(port))
        out.push(entry)
      } catch (e) {
        out.push({ port: Number(port), error: e.message })
      }
    }
    return out
  }
}

/** A device id as masters write it: decimal, or hex with an 0x in front. */
function toId (value) {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim()
  const n = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number(text)
  return Number.isFinite(n) ? n : undefined
}

const DEFAULT_PATHS = {
  readProcessDataIn: 'GET /iolink/port/{port}/pdin',
  readProcessDataOut: 'GET /iolink/port/{port}/pdout',
  writeProcessDataOut: 'POST /iolink/port/{port}/pdout',
  readIsdu: 'GET /iolink/port/{port}/isdu/{index}/{subindex}',
  writeIsdu: 'POST /iolink/port/{port}/isdu/{index}/{subindex}',
  readPortStatus: 'GET /iolink/port/{port}/status',
  // Without these two the IODD cannot be looked up from the device itself.
  readVendorId: 'GET /iolink/port/{port}/vendorid',
  readDeviceId: 'GET /iolink/port/{port}/deviceid',
  readProductName: 'GET /iolink/port/{port}/productname',
  readSerial: 'GET /iolink/port/{port}/serial'
}

module.exports = { GenericAdapter, DEFAULT_PATHS }
