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

  async scanPorts (ports) {
    const list = ports || this.config.ports || [1, 2, 3, 4, 5, 6, 7, 8]
    const out = []
    for (const port of list) {
      try {
        out.push({ ...(await this.readPortStatus(port)) })
      } catch (e) {
        out.push({ port: Number(port), error: e.message })
      }
    }
    return out
  }
}

const DEFAULT_PATHS = {
  readProcessDataIn: 'GET /iolink/port/{port}/pdin',
  readProcessDataOut: 'GET /iolink/port/{port}/pdout',
  writeProcessDataOut: 'POST /iolink/port/{port}/pdout',
  readIsdu: 'GET /iolink/port/{port}/isdu/{index}/{subindex}',
  writeIsdu: 'POST /iolink/port/{port}/isdu/{index}/{subindex}',
  readPortStatus: 'GET /iolink/port/{port}/status'
}

module.exports = { GenericAdapter, DEFAULT_PATHS }
