'use strict'

/**
 * Helpers shared by the runtime nodes: resolving which device sits on a port,
 * shaping the output message, and reporting failures the same way everywhere.
 */

const { DEVICE_STATUS, decodeDetailedDeviceStatus } = require('./iodd')

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

/**
 * Read what a device says about its own health.
 *
 * `DeviceStatus` (ISDU index 36) and `DetailedDeviceStatus` (index 37) are
 * specified for every IO-Link device, so this works through any master that can
 * read an ISDU - no vendor diagnosis API needed. Index 37 is the one devices
 * most often leave out, so a failure there is not a failure of the read: the
 * overall status is worth having on its own.
 */
async function readDeviceStatus (adapter, port) {
  const raw = await adapter.readIsdu(port, 36, 0)
  const value = raw === null || raw === undefined || raw === ''
    ? undefined
    : parseInt(String(raw), 16)
  const out = {
    deviceStatus: Number.isFinite(value) ? value : undefined,
    deviceStatusText: DEVICE_STATUS[value]
  }
  try {
    const detail = await adapter.readIsdu(port, 37, 0)
    if (detail) out.deviceEvents = decodeDetailedDeviceStatus(detail)
  } catch {
    // Index 37 is optional in practice; plenty of devices answer 36 and refuse it.
  }
  return out
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

/**
 * Work out which port a message addresses.
 *
 * The port can be typed into the node or taken from the message. When it comes
 * from the message and is not there, the number is not merely missing - it is
 * unknown, and reading port 1 instead would quietly return the wrong sensor's
 * data. So that is an error, with the name of the property that was empty.
 */
function resolvePort (RED, node, msg, config) {
  const configured = config.port
  const type = config.portType || 'num'
  if (configured === undefined || configured === null || configured === '') {
    // Nothing configured at all: the editor's own default, port 1.
    return 1
  }
  const raw = evaluate(RED, node, msg, configured, type, undefined)
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1) {
    const from = type === 'num' || type === 'str'
      ? `"${configured}"`
      : `${type}.${configured}, which held ${JSON.stringify(raw)},`
    throw Object.assign(
      new Error(`${from} is not a port number`), { code: 'IOLINK_BAD_PORT' })
  }
  return port
}

/**
 * Read a port list from a configuration field or from a message.
 *
 * Accepts an array, a comma-separated string, or a single number, because all
 * three are what people actually send. Something that was meant as a port list
 * but yields no port is an error rather than an empty list: scanning nothing,
 * or silently falling back to every port, hides the typo that caused it.
 */
function parsePorts (raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(',') : [raw]
  const ports = list
    .map(entry => Number(String(entry).trim()))
    .filter(port => Number.isInteger(port) && port >= 1)
  if (!ports.length) {
    throw Object.assign(
      new Error(`${JSON.stringify(raw)} is not a list of port numbers`),
      { code: 'IOLINK_BAD_PORT' })
  }
  return ports
}

/** Parse a JSON field the editor stores as text; blank and broken both mean "unset". */
function safeJson (raw) {
  if (!raw || typeof raw === 'object') return raw || undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Run tasks one after another, however many callers ask at once.
 *
 * The event node is polled by its timer and by incoming messages, and the two
 * must not run at the same time: both compare the ports against the state left
 * by the previous poll, so overlapping runs would diff against each other's
 * result and drop a change or report it twice.
 */
function serialiser () {
  let queue = Promise.resolve()
  return task => {
    // then(task, task) so one failed run does not stop the ones behind it.
    const result = queue.then(task, task)
    queue = result.catch(() => {})
    return result
  }
}

/**
 * Run `tick` now and then every `intervalMs`, for the nodes that poll a master
 * on their own rather than waiting for a message.
 *
 * Three things this gets right that a bare setInterval does not: the first
 * reading arrives at deploy instead of one interval later, a tick is skipped
 * rather than queued while the previous one is still running (a slow master
 * must not build a backlog), and nothing is sent after the node is closed -
 * a message from a stopped flow is at best confusing and at worst an error in
 * the runtime.
 *
 * @param {object} node    the node, used for send() and error()
 * @param {number} intervalMs
 * @param {(send: Function) => Promise} tick
 * @returns {Function} stop
 */
function startPolling (node, intervalMs, tick) {
  let inFlight = false
  let stopped = false

  const run = () => {
    if (inFlight || stopped) return
    inFlight = true
    Promise.resolve()
      .then(() => tick(m => { if (!stopped) node.send(m) }))
      // A polled read has no message to attach the error to, so it is reported
      // on the node itself rather than disappearing.
      .catch(e => { if (!stopped) node.error(e.message) })
      .then(() => { inFlight = false })
  }

  const timer = setInterval(run, intervalMs)
  const first = setTimeout(run, 0)
  return () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(first)
  }
}

/** Adapt a node's callback-style handler to the promise `startPolling` wants. */
const asTick = handler => send =>
  new Promise((resolve, reject) => handler({}, send, err => (err ? reject(err) : resolve())))

module.exports = {
  PortIdentityCache,
  parsePorts,
  safeJson,
  serialiser,
  resolveDevice,
  readDeviceStatus,
  shapeOutput,
  splitOutput,
  fail,
  evaluate,
  resolvePort,
  startPolling,
  asTick,
  shorten
}
