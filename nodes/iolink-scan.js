'use strict'
const { fail } = require('../lib/runtime')

module.exports = function (RED) {
  /**
   * Ask a master what is plugged into it: which ports are occupied, by which
   * device, and whether an IODD for it could be found.
   *
   * This is the node people reach for first when commissioning, and the one the
   * editor's scan button uses behind the scenes.
   */
  function IolinkScanNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)
    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }

    node.on('input', async function (msg, send, done) {
      try {
        const ports = msg.ports || parsePorts(config.ports)
        const result = await master.adapter.scanPorts(ports)

        if (config.resolveIodd !== false) {
          for (const entry of result) {
            if (!entry.vendorId || !entry.deviceId) continue
            try {
              const { device, source } = await master.iodd.device(
                entry.vendorId, entry.deviceId, master.parseOptions())
              entry.iodd = {
                source,
                vendorName: device.identity.vendorName,
                productName: (device.identity.variants[0] || {}).productId ||
                  device.identity.deviceName,
                ioLinkRevision: device.communication.ioLinkRevision,
                processDataVariants: device.variants,
                parameters: device.variables.length,
                warnings: device.warnings
              }
            } catch (e) {
              // A device without a published IODD is a normal finding, not a
              // failure of the scan.
              entry.iodd = { error: e.message, code: e.code }
            }
          }
        }

        const found = result.filter(p => p.connected).length
        node.status({ fill: 'green', shape: 'dot', text: `${found} of ${result.length} ports in use` })
        send({ ...msg, payload: result, timestamp: new Date().toISOString() })
        if (done) done()
      } catch (e) {
        fail(node, msg, e, done)
      }
    })
  }

  const parsePorts = raw => {
    if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite)
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split(',').map(s => Number(s.trim())).filter(Number.isFinite)
    }
    return undefined
  }

  RED.nodes.registerType('iolink-scan', IolinkScanNode)
}
