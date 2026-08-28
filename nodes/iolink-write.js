'use strict'
const { PortIdentityCache, resolveDevice, fail, resolvePort } = require('../lib/runtime')

module.exports = function (RED) {
  /**
   * Write process data output: valves, actuators, signal towers.
   *
   * By default the device's current output is read first and used as the base,
   * so setting one field leaves the others alone. Without that, writing
   * `{ Valve: true }` to a manifold would zero every other valve - the kind of
   * mistake that is obvious only once something moves.
   */
  function IolinkWriteNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)
    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }

    const identityCache = new PortIdentityCache(Number(config.identityTtl) || 30000)
    const merge = config.merge !== false

    node.on('input', async function (msg, send, done) {
      try {
        const port = resolvePort(RED, node, msg, config)
        const values = collectValues(msg, config)
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          throw Object.assign(
            new Error('expected an object of values to write, e.g. { "Valve": true }'),
            { code: 'IOLINK_BAD_PAYLOAD' })
        }

        const { device, status } = await resolveDevice(master, port, {
          identityCache,
          vendorId: config.vendorId ? Number(config.vendorId) : undefined,
          deviceId: config.deviceId ? Number(config.deviceId) : undefined
        })

        const opts = { variant: config.variant || undefined }
        const layout = device.layout('out', opts)

        let base
        if (merge && Object.keys(values).length < layout.items.length) {
          try {
            base = await master.adapter.readProcessDataOut(port)
          } catch (e) {
            // Not every master can read its output back. Say so rather than
            // silently zeroing the fields the flow did not mention.
            throw Object.assign(new Error(
              `cannot read the current output of port ${port} to merge into ` +
              `(${e.message}). Supply every value, or turn off "merge".`),
            { code: 'IOLINK_MERGE_UNAVAILABLE' })
          }
        }

        const buf = device.encodeOut(values, {
          ...opts,
          base: base || undefined,
          ignoreRange: Boolean(config.ignoreRange)
        })
        const hex = buf.toString('hex')
        await master.adapter.writeProcessDataOut(port, hex)

        node.status({ fill: 'green', shape: 'dot', text: `port ${port}: wrote ${hex}` })
        send({
          ...msg,
          payload: values,
          iolink: { raw: hex, layout: layout.id, octets: layout.octetLength, merged: Boolean(base) },
          device: {
            vendor: device.identity.vendorName,
            product: (device.identity.variants[0] || {}).productId,
            serial: status && status.serial,
            port
          },
          timestamp: new Date().toISOString()
        })
        if (done) done()
      } catch (e) {
        fail(node, msg, e, done)
      }
    })

    node.on('close', function (done) { identityCache.clear(); done() })
  }

  function collectValues (msg, config) {
    if (config.values && String(config.values).trim()) {
      try {
        const fixed = JSON.parse(config.values)
        // Values configured in the editor act as defaults the message overrides.
        return { ...fixed, ...(typeof msg.payload === 'object' && msg.payload ? msg.payload : {}) }
      } catch {
        // fall through to the payload
      }
    }
    return msg.payload
  }

  RED.nodes.registerType('iolink-write', IolinkWriteNode)
}
