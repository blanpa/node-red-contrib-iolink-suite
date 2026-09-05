'use strict'
const { MasterAdapter, MasterError, toHex } = require('./base')
const { requestJson } = require('../http')

/**
 * ifm IoT Core (AL13xx / AL19xx / AL2xxx families).
 *
 * One POST endpoint takes every request:
 *   { "code": "request", "cid": 4711,
 *     "adr": "/iolinkmaster/port[1]/iolinkdevice/pdin/getdata" }
 * and answers
 *   { "cid": 4711, "code": 200, "data": { "value": "03C9" } }
 *
 * `code` is the IoT Core diagnostic code, not the HTTP status: a masked failure
 * arrives as HTTP 200 with code 400+, so both are checked.
 */
class IfmAdapter extends MasterAdapter {
  static get label () { return 'ifm IoT Core' }

  constructor (config) {
    super(config)
    const scheme = config.tls ? 'https' : 'http'
    const port = config.httpPort ? `:${config.httpPort}` : ''
    this.baseUrl = config.url || `${scheme}://${config.host}${port}/`
    this.auth = config.user ? { user: config.user, password: config.password } : undefined
    this.fetchImpl = config.fetchImpl
    this._cid = Math.floor(Math.random() * 10000)
  }

  async _call (adr, data) {
    const cid = ++this._cid
    const body = { code: 'request', cid, adr }
    if (data !== undefined) body.data = data
    const reply = await requestJson(this.baseUrl, {
      body, timeout: this.timeout, auth: this.auth, fetchImpl: this.fetchImpl
    })
    const code = Number(reply.code)
    if (code !== 200) {
      throw new MasterError(
        `ifm IoT Core rejected "${adr}" with code ${reply.code}` +
        (reply.data && reply.data.message ? `: ${reply.data.message}` : ''),
        { adr, ioTCoreCode: code, reply })
    }
    return reply.data
  }

  _port (port, tail) {
    return `/iolinkmaster/port[${port}]/${tail}`
  }

  async identify () {
    const [name, serial] = await Promise.all([
      this._call('/deviceinfo/productcode/getdata').catch(() => null),
      this._call('/deviceinfo/serialnumber/getdata').catch(() => null)
    ])
    return {
      profile: 'ifm',
      product: name && name.value,
      serial: serial && serial.value,
      url: this.baseUrl
    }
  }

  async readProcessDataIn (port) {
    const data = await this._call(this._port(port, 'iolinkdevice/pdin/getdata'))
    return toHex(data && data.value)
  }

  async readProcessDataOut (port) {
    const data = await this._call(this._port(port, 'iolinkdevice/pdout/getdata'))
    return toHex(data && data.value)
  }

  async writeProcessDataOut (port, hex) {
    // The master expects an even-length hex string; it echoes no value back.
    await this._call(this._port(port, 'iolinkdevice/pdout/setdata'),
      { newvalue: String(hex).toUpperCase() })
    return true
  }

  async readIsdu (port, index, subindex = 0) {
    const data = await this._call(this._port(port, 'iolinkdevice/iolreadacyclic'),
      { index: Number(index), subindex: Number(subindex) })
    return toHex(data && data.value)
  }

  async writeIsdu (port, index, subindex = 0, hex) {
    await this._call(this._port(port, 'iolinkdevice/iolwriteacyclic'),
      { index: Number(index), subindex: Number(subindex), value: String(hex).toUpperCase() })
    return true
  }

  async readPortStatus (port) {
    const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ error }))
    const [status, mode, pdValid] = await Promise.all([
      settle(this._call(this._port(port, 'iolinkdevice/status/getdata'))),
      settle(this._call(this._port(port, 'mode/getdata'))),
      this._call(this._port(port, 'iolinkdevice/pdin/getdata')).then(() => true, () => false)
    ])
    // An empty port still answers with status 0, so a port that answers nothing
    // at all is not empty: the master is unreachable, or the port does not
    // exist. Reporting that as "no device" would turn an outage into silence.
    if (!status.ok && !mode.ok) throw status.error
    const statusValue = status.value && Number(status.value.value)
    return {
      port: Number(port),
      // IoT Core reports 0 = not connected, 1 = pre-operate, 2 = operate.
      connected: statusValue === 2 || statusValue === 1,
      operational: statusValue === 2,
      status: statusValue,
      statusText: PORT_STATUS[statusValue],
      mode: mode.value && Number(mode.value.value),
      modeText: PORT_MODE[mode.value && Number(mode.value.value)],
      processDataAvailable: pdValid
    }
  }

  async scanPorts (ports) {
    const list = ports || this.config.ports || [1, 2, 3, 4, 5, 6, 7, 8]
    const out = []
    for (const port of list) {
      const entry = { port: Number(port) }
      try {
        Object.assign(entry, await this.readPortStatus(port))
        if (entry.connected) {
          const [vendorId, deviceId, productName, serial] = await Promise.all([
            this._call(this._port(port, 'iolinkdevice/vendorid/getdata')).catch(() => null),
            this._call(this._port(port, 'iolinkdevice/deviceid/getdata')).catch(() => null),
            this._call(this._port(port, 'iolinkdevice/productname/getdata')).catch(() => null),
            this._call(this._port(port, 'iolinkdevice/serial/getdata')).catch(() => null)
          ])
          entry.vendorId = vendorId && Number(vendorId.value)
          entry.deviceId = deviceId && Number(deviceId.value)
          entry.productName = productName && productName.value
          entry.serial = serial && serial.value
        }
      } catch (e) {
        // IoT Core answered and refused: a port that does not exist, say.
        // That is a state of the port, not an outage of the master.
        if (e.ioTCoreCode !== undefined) {
          entry.connected = false
          entry.statusText = e.message
        } else {
          entry.error = e.message
        }
      }
      out.push(entry)
    }
    return out
  }
}

const PORT_STATUS = {
  0: 'no device',
  1: 'device connected (pre-operate)',
  2: 'device connected (operate)',
  3: 'incorrect device',
  4: 'device connected, communication error'
}

const PORT_MODE = {
  0: 'deactivated',
  1: 'IO-Link',
  2: 'digital input (DI)',
  3: 'digital output (DO)'
}

module.exports = { IfmAdapter }
