'use strict'
const {
  PortIdentityCache, resolveDevice, shapeOutput, splitOutput, fail, resolvePort,
  startPolling, asTick, safeJson
} = require('../lib/runtime')

module.exports = function (RED) {
  /**
   * Read a port's process data input and decode it through the device's IODD.
   *
   * Triggered by an incoming message, or on an interval. The port's identity is
   * cached briefly: re-scanning vendorId and deviceId before every read would
   * triple the traffic to the master for no benefit, but pinning it forever
   * would survive a device being swapped, so it expires.
   */
  function IolinkReadNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)

    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }

    const identityCache = new PortIdentityCache(Number(config.identityTtl) || 30000)
    const selected = Array.isArray(config.values) ? config.values.filter(Boolean) : []
    const splitMode = config.output === 'split'
    let stopPolling = null

    async function readOnce (msg, send, done) {
      let port
      try {
        port = resolvePort(RED, node, msg, config)
        const { device, status } = await resolveDevice(master, port, {
          identityCache,
          vendorId: config.vendorId ? Number(config.vendorId) : undefined,
          deviceId: config.deviceId ? Number(config.deviceId) : undefined,
          parseOptions: config.conditions ? { conditions: safeJson(config.conditions) } : undefined
        })

        const raw = await master.adapter.readProcessDataIn(port)
        if (raw === null || raw === undefined) {
          throw Object.assign(new Error(`port ${port} returned no process data`),
            { code: 'IOLINK_NO_DATA' })
        }

        const decodeOptions = {
          variant: config.variant || undefined,
          enums: config.enums === 'text' ? 'text' : undefined
        }
        const layout = device.layout('in', decodeOptions)
        const { payload, meta } = device.decodeIn(raw, decodeOptions)

        const filtered = selected.length
          ? {
              payload: pick(payload, selected),
              meta: pick(meta, selected)
            }
          : { payload, meta }

        const base = shapeOutput({
          ...filtered,
          device,
          status,
          port,
          raw,
          layout,
          extra: device.warnings.length ? { warnings: device.warnings } : undefined
        })

        const count = Object.keys(base.payload).length
        node.status({ fill: 'green', shape: 'dot', text: `port ${port}: ${count} value${count === 1 ? '' : 's'}` })

        if (splitMode) {
          send([splitOutput(base, config.topicPrefix || `iolink/port${port}`, msg)])
        } else {
          send({ ...msg, ...base })
        }
        if (done) done()
      } catch (e) {
        fail(node, msg, e, done)
      }
    }

    node.on('input', (msg, send, done) => { readOnce(msg, send, done) })

    const interval = Number(config.interval) || 0
    if (interval > 0) {
      node.status({ fill: 'grey', shape: 'ring', text: `polling every ${interval} ms` })
      stopPolling = startPolling(node, interval, asTick(readOnce))
    }

    node.on('close', function (done) {
      if (stopPolling) stopPolling()
      identityCache.clear()
      done()
    })
  }

  const pick = (obj, keys) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)))

  RED.nodes.registerType('iolink-read', IolinkReadNode)
}
