'use strict'
const { MasterAdapter, MasterError, toHex } = require('./base')
const { requestJson } = require('../http')

/**
 * The IO-Link Community's "JSON Integration for IO-Link" REST API
 * (specification 10.222, V1.0.0, March 2020; OpenAPI at
 * github.com/iolinkcommunity/JSON_for_IO-Link).
 *
 * This is the one interface several vendors share rather than one vendor's
 * own: Balluff and Pepperl+Fuchs ship it on their newer masters, and others
 * are following. Everything sits under `/iolink/v1`. A port is addressed by
 * master number and port number for its status, and by a *device alias* for
 * everything that goes to the device on it - `master1port2` unless someone
 * renamed it in the port configuration. The adapter looks the aliases up once
 * and falls back to the default name when the master will not list them.
 *
 * Values are asked for as `byteArray` - plain arrays of octets - so the IODD
 * decoding stays in lib/iodd like it does for every other profile. The API's
 * own `iodd` format, which would have the master decode, is deliberately not
 * used: it needs the IODD uploaded to the master, and its output shape is
 * vendor-dependent in practice.
 *
 * Built from the specification; not yet checked against a master. Where a
 * vendor deviates, `scripts/record-master.js` captures what it really says.
 */
class JsonApiAdapter extends MasterAdapter {
  static get label () { return 'IO-Link JSON API' }

  constructor (config) {
    super(config)
    const scheme = config.tls ? 'https' : 'http'
    const httpPort = config.httpPort ? `:${config.httpPort}` : ''
    let base = (config.url || `${scheme}://${config.host}${httpPort}`).replace(/\/+$/, '')
    // The specification fixes the prefix, so a base URL without it gets it;
    // one that already ends in it (a proxy, a different version) is left alone.
    if (!/\/iolink\/v\d+$/.test(base)) base += '/iolink/v1'
    this.baseUrl = base
    this.masterNumber = Number(config.masterNumber) || 1
    this.auth = config.user ? { user: config.user, password: config.password } : undefined
    this.fetchImpl = config.fetchImpl
    this._aliases = null
    this._aliasesAt = 0
  }

  /**
   * One request, with the API's own error object folded into the message.
   * The specification puts a numeric `code` and a `message` in every error
   * body; the message is what a person needs, the code is kept for flows.
   */
  async _call (method, path, body) {
    const url = this.baseUrl + path
    try {
      return await requestJson(url, {
        method, body, timeout: this.timeout, auth: this.auth, fetchImpl: this.fetchImpl
      })
    } catch (e) {
      const api = e.body && typeof e.body === 'object' && e.body.code !== undefined ? e.body : null
      if (!api) throw e
      const detail = api.iolinkError && api.iolinkError.message
        ? ` - ${api.iolinkError.message}`
        : ''
      throw new MasterError(`${api.message}${detail} (JSON API code ${api.code}, ${method} ${path})`,
        { url, status: e.status, apiCode: Number(api.code), iolinkError: api.iolinkError })
    }
  }

  _master (tail) { return `/masters/${this.masterNumber}${tail}` }

  _device (alias, tail) { return `/devices/${encodeURIComponent(alias)}${tail}` }

  /**
   * The alias the master knows a port's device by.
   *
   * Asked for as a list, once a minute at most: the default `masterNportM`
   * is what most masters use, but a renamed port would otherwise answer 304
   * "deviceAlias not found" for ever. A master that cannot list its ports is
   * assumed to use the defaults.
   */
  async _alias (port, { refresh = false } = {}) {
    const stale = Date.now() - this._aliasesAt > 60000
    if (refresh || stale || !this._aliases) {
      this._aliases = new Map()
      this._aliasesAt = Date.now()
      try {
        const list = await this._call('GET', this._master('/ports'))
        for (const entry of Array.isArray(list) ? list : []) {
          if (entry && entry.portNumber !== undefined && entry.deviceAlias) {
            this._aliases.set(Number(entry.portNumber), String(entry.deviceAlias))
          }
        }
      } catch (e) {
        // A master that will not list its ports still has to be reachable:
        // that failure says nothing about aliases and everything about the
        // connection, so it is not swallowed.
        if (!e.status) throw e
      }
    }
    return this._aliases.get(Number(port)) || `master${this.masterNumber}port${port}`
  }

  /** Run `task` with the port's alias; on "alias not found" look the aliases up again once. */
  async _withAlias (port, task) {
    try {
      return await task(await this._alias(port))
    } catch (e) {
      if (e.apiCode !== 304) throw e
      return task(await this._alias(port, { refresh: true }))
    }
  }

  async identify () {
    const info = await this._call('GET', this._master('/identification'))
    return {
      profile: 'jsonapi',
      vendor: info.vendorName,
      product: info.productName || info.orderCode,
      serial: info.serialNumber,
      url: this.baseUrl
    }
  }

  async readPortStatus (port) {
    const status = await this._call('GET', this._master(`/ports/${Number(port)}/status`))
    const info = String(status.statusInfo || 'NOT_AVAILABLE')
    return {
      port: Number(port),
      connected: info === 'DEVICE_ONLINE' || info === 'DEVICE_STARTING',
      operational: info === 'DEVICE_ONLINE',
      status: info,
      statusText: PORT_STATUS[info] || info,
      ioLinkRevision: status.ioLinkRevision,
      transmissionRate: status.transmissionRate,
      cycleTime: status.masterCycleTime && status.masterCycleTime.value
    }
  }

  async _identity (port) {
    const id = await this._withAlias(port, alias =>
      this._call('GET', this._device(alias, '/identification')))
    const out = {}
    if (id.vendorId !== undefined) out.vendorId = Number(id.vendorId)
    if (id.deviceId !== undefined) out.deviceId = Number(id.deviceId)
    if (id.productName) out.productName = String(id.productName)
    if (id.serialNumber) out.serial = String(id.serialNumber)
    if (id.vendorName) out.vendorName = String(id.vendorName)
    return out
  }

  async scanPorts (ports) {
    const list = ports || this.config.ports || [1, 2, 3, 4, 5, 6, 7, 8]
    const out = []
    for (const port of list) {
      const entry = { port: Number(port) }
      try {
        Object.assign(entry, await this.readPortStatus(port))
        if (entry.connected) Object.assign(entry, await this._identity(port))
      } catch (e) {
        // The master answered, about this port: that is a port state, not an
        // outage. Only a master that could not be asked at all is an outage.
        if (e.apiCode !== undefined) {
          entry.connected = false
          entry.statusText = e.message
          entry.apiCode = e.apiCode
        } else {
          entry.error = e.message
        }
      }
      out.push(entry)
    }
    return out
  }

  async _processData (port, which) {
    const reply = await this._withAlias(port, alias =>
      this._call('GET', this._device(alias, `/processdata/${which}/value?format=byteArray`)))
    const pd = reply && reply.ioLink
    if (!pd) return null
    if (pd.valid === false) {
      throw new MasterError(`the master marks the process data of port ${port} as invalid`,
        { port: Number(port), operation: which })
    }
    return toHex(pd.value)
  }

  async readProcessDataIn (port) { return this._processData(port, 'getdata') }

  async readProcessDataOut (port) { return this._processData(port, 'setdata') }

  async writeProcessDataOut (port, hex) {
    await this._withAlias(port, alias =>
      this._call('POST', this._device(alias, '/processdata/value'),
        { ioLink: { valid: true, value: octets(hex) } }))
    return true
  }

  _parameterPath (index, subindex) {
    const sub = Number(subindex) || 0
    return sub === 0
      ? `/parameters/${Number(index)}/value`
      : `/parameters/${Number(index)}/subindices/${sub}/value`
  }

  async readIsdu (port, index, subindex = 0) {
    const reply = await this._withAlias(port, alias =>
      this._call('GET', this._device(alias, this._parameterPath(index, subindex) + '?format=byteArray')))
    return toHex(Array.isArray(reply) ? reply : reply && reply.value)
  }

  async writeIsdu (port, index, subindex = 0, hex) {
    await this._withAlias(port, alias =>
      this._call('POST', this._device(alias, this._parameterPath(index, subindex)), octets(hex)))
    return true
  }
}

/** A hex string as the array of octets the API wants. */
function octets (hex) {
  return Array.from(Buffer.from(String(hex).replace(/[^0-9a-fA-F]/g, ''), 'hex'))
}

/** The specification's port states, in words. */
const PORT_STATUS = {
  DEVICE_ONLINE: 'device connected (operate)',
  DEVICE_STARTING: 'device connected (starting)',
  INCORRECT_DEVICE: 'incorrect device',
  COMMUNICATION_LOST: 'communication lost',
  DEACTIVATED: 'port deactivated',
  'DIGITAL_INPUT_C/Q': 'digital input (DI)',
  'DIGITAL_OUTPUT_C/Q': 'digital output (DO)',
  NOT_AVAILABLE: 'no device'
}

module.exports = { JsonApiAdapter, PORT_STATUS }
