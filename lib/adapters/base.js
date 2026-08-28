'use strict'
const { MasterError } = require('../http')

/**
 * What every master adapter must provide.
 *
 * Adapters deal in RAW BYTES only. Decoding belongs to lib/iodd, so adding a
 * vendor never touches the decoding path, and the decoding path stays usable by
 * people whose process data arrives over PROFINET or OPC UA instead.
 *
 * Raw process data is exchanged as lower-case hex strings, the form every
 * vendor's web API already uses.
 */
class MasterAdapter {
  /** @param {object} config connection settings from the iolink-master node */
  constructor (config) {
    this.config = config
    this.timeout = config.timeout ?? 5000
  }

  /** Human-readable name of the profile, shown in node status and errors. */
  static get label () { return this.name }

  /** `{ vendorId, deviceId, productName, serial, status, mode }` per port. */
  async scanPorts () { throw notImplemented('scanPorts') }

  /** Raw process data input of one port, as a hex string. */
  async readProcessDataIn (port) { throw notImplemented('readProcessDataIn') }

  /** Raw process data output of one port, as a hex string. */
  async readProcessDataOut (port) { throw notImplemented('readProcessDataOut') }

  /** Write raw process data output. `hex` is a lower-case hex string. */
  async writeProcessDataOut (port, hex) { throw notImplemented('writeProcessDataOut') }

  /** Read an ISDU parameter, returning a hex string. */
  async readIsdu (port, index, subindex) { throw notImplemented('readIsdu') }

  /** Write an ISDU parameter from a hex string. */
  async writeIsdu (port, index, subindex, hex) { throw notImplemented('writeIsdu') }

  /** Port status and diagnosis: `{ port, connected, mode, status, events }`. */
  async readPortStatus (port) { throw notImplemented('readPortStatus') }

  /** Master identification, for the config node's connection test. */
  async identify () { throw notImplemented('identify') }

  /**
   * Optional: push updates instead of polling.
   * Returns an unsubscribe function, or null when the profile cannot push.
   */
  async subscribe () { return null }
}

const notImplemented = what =>
  new MasterError(`this master profile does not implement ${what}()`, { operation: what })

/** Normalise the many ways a hex string arrives from a web API. */
function toHex (value) {
  if (value === undefined || value === null) return null
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (Array.isArray(value)) return Buffer.from(value).toString('hex')
  return String(value).trim().replace(/^0x/i, '').replace(/[\s:_-]/g, '').toLowerCase()
}

module.exports = { MasterAdapter, MasterError, toHex }
