'use strict'

/**
 * Helpers shared by the runtime nodes: resolving which device sits on a port,
 * shaping the output message, and reporting failures the same way everywhere.
 */

/** Cache of port -> device identity, so every read does not re-scan the port. */
class PortIdentityCache {
  constructor (ttlMs = 30000) {
    this.ttl = ttlMs
    this.entries = new Map()
  }

  async get (adapter, port, { force = false } = {}) {
    const now = Date.now()
    const hit = this.entries.get(port)
    if (!force && hit && now - hit.at < this.ttl) return hit.value
    const [status] = await adapter.scanPorts([port])
    this.entries.set(port, { at: now, value: status })
    return status
  }

  clear () { this.entries.clear() }
}

/**
 * Work out which device is on a port and load its IODD.
 * Identity can be pinned in the node config for masters that cannot report it.
 */
async function resolveDevice (master, port, options = {}) {
  let vendorId = options.vendorId
  let deviceId = options.deviceId
  let status = null

  if (!vendorId || !deviceId) {
    status = await options.identityCache.get(master.adapter, port, { force: options.force })
    if (!status || !status.vendorId || !status.deviceId) {
      const detail = status && status.statusText ? ` (${status.statusText})` : ''
      const e = new Error(`port ${port} reports no IO-Link device${detail}`)
      e.code = 'IOLINK_NO_DEVICE'
      e.port = port
      throw e
    }
    vendorId = status.vendorId
    deviceId = status.deviceId
  }

  const parseOptions = { ...master.parseOptions(), ...options.parseOptions }
  const { device, source } = await master.iodd.device(vendorId, deviceId, parseOptions)
  return { device, status, source, vendorId, deviceId }
}

/** Build the standard output message body. */
function shapeOutput ({ payload, meta, device, status, port, raw, layout, extra }) {
  const identity = device.identity
  return {
    payload,
    meta,
    device: {
      vendor: identity.vendorName,
      vendorId: identity.vendorId,
      deviceId: identity.deviceId,
      product: (identity.variants[0] || {}).productId || identity.deviceName,
      serial: status && status.serial,
      port
    },
    iolink: {
      raw,
      layout: layout && layout.id,
      octets: layout && layout.octetLength,
      ...extra
    },
    timestamp: new Date().toISOString()
  }
}

/**
 * One message per value, for flows that map tags onto MQTT topics.
 *
 * The incoming message is carried into every split message: dropping it would
 * lose `msg.res` in an HTTP flow and any correlation the caller put on the
 * message, which is a surprise nobody wants halfway down a flow.
 */
function splitOutput (base, topicPrefix, source = {}) {
  return Object.entries(base.payload).map(([key, value]) => ({
    ...source,
    ...base,
    topic: topicPrefix ? `${topicPrefix}/${key}` : key,
    payload: value,
    meta: base.meta[key]
  }))
}

/** Consistent node status and error reporting. */
function fail (node, msg, error, done) {
  const text = error.code ? `${error.code}: ${error.message}` : error.message
  node.status({ fill: 'red', shape: 'ring', text: shorten(error.message) })
  if (done) done(Object.assign(error, { message: text }))
  else node.error(text, msg)
}

const shorten = (text, max = 40) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text

/** Read a value from msg using a Node-RED typed input. */
function evaluate (RED, node, msg, value, type, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  try {
    const out = RED.util.evaluateNodeProperty(value, type || 'str', node, msg)
    return out === undefined || out === '' ? fallback : out
  } catch {
    return fallback
  }
}

module.exports = { PortIdentityCache, resolveDevice, shapeOutput, splitOutput, fail, evaluate, shorten }
