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
 *
 * Protocol details follow the ifm operating instructions for the AL1352
 * (document 80284138, chapter 9.2 "ifm IoT Core"), cross-checked against the
 * UMH sensorconnect plugin which runs against these masters in production.
 */
class IfmAdapter extends MasterAdapter {
  static get label () { return 'ifm IoT Core' }

  constructor (config) {
    super(config)
    const scheme = config.tls ? 'https' : 'http'
    const port = config.httpPort ? `:${config.httpPort}` : ''
    this.baseUrl = config.url || `${scheme}://${config.host}${port}/`
    // In security mode the IoT Core authenticates through an `auth` field in
    // the JSON body, with user and password Base64-coded (manual 9.2.7). The
    // user name is fixed to "administrator", so a password alone is enough.
    this.auth = (config.user || config.password)
      ? { user: config.user || 'administrator', password: config.password || '' }
      : undefined
    this.fetchImpl = config.fetchImpl
    this._cid = Math.floor(Math.random() * 10000)
  }

  _nextCid () {
    // The manual calls cid "freely assignable"; sensorconnect found masters
    // that stop answering above ~32764, so stay well inside a signed 16-bit range.
    this._cid = this._cid >= 30000 ? 1 : this._cid + 1
    return this._cid
  }

  async _call (adr, data) {
    const body = { code: 'request', cid: this._nextCid(), adr }
    if (data !== undefined) body.data = data
    if (this.auth) {
      body.auth = {
        user: Buffer.from(this.auth.user).toString('base64'),
        passwd: Buffer.from(this.auth.password).toString('base64')
      }
    }
    const reply = await requestJson(this.baseUrl, {
      body, timeout: this.timeout, fetchImpl: this.fetchImpl
    })
    const code = Number(reply.code)
    // 200 is OK; 230-233 are "OK, but..." (needs reboot, block request pending,
    // value accepted but adjusted, IP settings updated). None of them is a failure.
    if (!(code >= 200 && code < 300)) {
      const text = DIAGNOSTIC_CODES[code]
      const detail = reply.data && reply.data.message
      throw new MasterError(
        `ifm IoT Core rejected "${adr}" with code ${reply.code}` +
        (text ? ` (${text})` : '') + (detail ? `: ${detail}` : ''),
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
    const modeValue = mode.value && Number(mode.value.value)
    const label = (table, value, what) =>
      value === undefined || value === null || Number.isNaN(value)
        ? undefined
        : (table[value] || `unknown ${what} ${value}`)
    return {
      port: Number(port),
      connected: statusValue === 2 || statusValue === 1,
      operational: statusValue === 2,
      status: statusValue,
      statusText: label(PORT_STATUS, statusValue, 'status'),
      mode: modeValue,
      modeText: label(PORT_MODE, modeValue, 'mode'),
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

// IoT Core `port[n]/iolinkdevice/status`. The ifm manual lists the data point
// but not its values; 0-3 are what integrations running against these masters
// agree on (Corlina, ioBroker io-link). Other values are reported as unknown.
const PORT_STATUS = {
  0: 'no device',
  1: 'device connected (pre-operate)',
  2: 'device connected (operate)',
  3: 'incorrect device / communication error'
}

// IoT Core `port[n]/mode`: 0 = deactivated, 1 = DI, 2 = DO, 3 = IO-Link
// (ifm port-mode guide; sensorconnect; issue #2 on an AL1352).
const PORT_MODE = {
  0: 'deactivated',
  1: 'digital input (DI)',
  2: 'digital output (DO)',
  3: 'IO-Link'
}

// IoT Core diagnostic codes (manual 9.2.1, "IoT Core: Diagnostic codes").
const DIAGNOSTIC_CODES = {
  200: 'OK',
  230: 'OK but needs reboot',
  231: 'OK but block request not finished',
  232: 'data accepted but internally modified',
  233: 'IP settings updated, reload device',
  400: 'bad request',
  401: 'unauthorized: security mode is active, check user and password',
  403: 'forbidden',
  500: 'internal server error',
  503: 'service unavailable: port in wrong operating mode or no IO-Link device on the port',
  530: 'requested data is invalid',
  531: 'IO-Link error in master or device',
  532: 'IO-Link master is still connected to the fieldbus PLC'
}

module.exports = { IfmAdapter, PORT_STATUS, PORT_MODE, DIAGNOSTIC_CODES }
