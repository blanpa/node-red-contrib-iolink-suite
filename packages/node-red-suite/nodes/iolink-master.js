'use strict'
const { createAdapter, listProfiles } = require('../lib/adapters')
const { IoddStore } = require('../lib/iodd-store')

module.exports = function (RED) {
  /**
   * Configuration node: one per physical IO-Link master.
   *
   * It owns the connection and the IODD store, so several read/write/param
   * nodes pointing at the same master share one parsed IODD per device rather
   * than each keeping its own copy.
   */
  function IolinkMasterNode (config) {
    RED.nodes.createNode(this, config)
    const node = this

    node.profile = config.profile || 'ifm'
    node.name = config.name
    node.host = config.host

    const credentials = node.credentials || {}
    node.settings = {
      host: config.host,
      httpPort: config.httpPort,
      url: config.url,
      tls: config.tls,
      timeout: Number(config.timeout) || 5000,
      ports: parsePorts(config.ports),
      user: credentials.user || undefined,
      password: credentials.password || undefined,
      paths: safeJson(config.paths),
      valuePath: config.valuePath || undefined
    }

    node.adapter = createAdapter(node.profile, node.settings)

    node.iodd = new IoddStore({
      cacheDir: config.ioddCacheDir || undefined,
      localDir: config.ioddDir || undefined,
      offline: Boolean(config.offline),
      timeout: Number(config.timeout) || 5000
    })

    /** Parse options every node under this master shares. */
    node.parseOptions = () => ({
      language: config.language || 'en',
      keyStyle: config.keyStyle || 'preserve'
    })

    node.on('close', function (done) {
      node.iodd.clear()
      done()
    })
  }

  RED.nodes.registerType('iolink-master', IolinkMasterNode, {
    credentials: {
      user: { type: 'text' },
      password: { type: 'password' }
    }
  })

  const parsePorts = raw => {
    if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite)
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split(',').map(s => Number(s.trim())).filter(Number.isFinite)
    }
    return undefined
  }

  const safeJson = raw => {
    if (!raw || typeof raw === 'object') return raw || undefined
    try { return JSON.parse(raw) } catch { return undefined }
  }

  // ---------------------------------------------------------------- editor API
  // These endpoints are what turn the editor from "type in a bit offset" into
  // "tick the values you want".

  const withMaster = handler => async (req, res) => {
    const node = RED.nodes.getNode(req.params.id)
    if (!node || node.type !== 'iolink-master') {
      return res.status(404).json({ error: 'unknown or unconfigured master' })
    }
    try {
      res.json(await handler(node, req))
    } catch (e) {
      res.status(500).json({ error: e.message, code: e.code })
    }
  }

  RED.httpAdmin.get('/iolink-suite/profiles',
    RED.auth.needsPermission('flows.read'),
    (_req, res) => res.json(listProfiles()))

  /** Ask the master which ports are occupied and by what. */
  RED.httpAdmin.get('/iolink-suite/scan/:id',
    RED.auth.needsPermission('flows.write'),
    withMaster(async node => {
      const ports = await node.adapter.scanPorts()
      // Attach the IODD product name where we can get one; a device that has no
      // published IODD still shows up, just without decoded value names.
      for (const entry of ports) {
        if (!entry.vendorId || !entry.deviceId) continue
        try {
          const { device, source } = await node.iodd.device(
            entry.vendorId, entry.deviceId, node.parseOptions())
          entry.iodd = {
            source,
            vendorName: device.identity.vendorName,
            productName: (device.identity.variants[0] || {}).productId ||
              device.identity.deviceName,
            variants: device.variants.length,
            warnings: device.warnings
          }
        } catch (e) {
          entry.iodd = { error: e.message }
        }
      }
      return ports
    }))

  /** List the decoded values available on a port, for the checkbox picker. */
  RED.httpAdmin.get('/iolink-suite/datapoints/:id/:port',
    RED.auth.needsPermission('flows.write'),
    withMaster(async (node, req) => {
      const port = Number(req.params.port)
      const direction = req.query.direction === 'out' ? 'out' : 'in'
      const [status] = await node.adapter.scanPorts([port])
      if (!status || !status.vendorId) {
        throw new Error(`port ${port} reports no IO-Link device`)
      }
      const { device } = await node.iodd.device(
        status.vendorId, status.deviceId, node.parseOptions())

      const variantId = req.query.variant || undefined
      const variants = device.variants
      let layout
      try {
        layout = device.layout(direction, { variant: variantId })
      } catch (e) {
        return { device: describe(device), variants, error: e.message, code: e.code, items: [] }
      }
      return {
        device: describe(device),
        variants,
        layout: { id: layout.id, name: layout.name, octetLength: layout.octetLength },
        items: layout.items.map(i => ({
          key: i.key,
          name: i.name,
          type: i.type,
          unit: i.unit,
          bitOffset: i.bitOffset,
          bitLength: i.bitLength,
          subindex: i.subindex,
          min: i.min,
          max: i.max,
          description: i.description,
          scalingAmbiguous: i.scalingAmbiguous
        }))
      }
    }))

  /** List the ISDU parameters of a port, for the parameter picker. */
  RED.httpAdmin.get('/iolink-suite/parameters/:id/:port',
    RED.auth.needsPermission('flows.write'),
    withMaster(async (node, req) => {
      const port = Number(req.params.port)
      const [status] = await node.adapter.scanPorts([port])
      if (!status || !status.vendorId) throw new Error(`port ${port} reports no IO-Link device`)
      const { device } = await node.iodd.device(
        status.vendorId, status.deviceId, node.parseOptions())
      return {
        device: describe(device),
        parameters: device.variables
          .filter(v => !v.unsupported)
          .map(v => ({
            id: v.id,
            index: v.index,
            name: v.name,
            access: v.access,
            type: v.type,
            unit: v.unit,
            min: v.min,
            max: v.max,
            standard: Boolean(v.standard),
            subindexes: (v.items || []).map(i => ({ subindex: i.subindex, name: i.name, type: i.type, unit: i.unit }))
          }))
      }
    }))

  const describe = device => ({
    vendorId: device.identity.vendorId,
    deviceId: device.identity.deviceId,
    vendorName: device.identity.vendorName,
    productName: (device.identity.variants[0] || {}).productId || device.identity.deviceName,
    warnings: device.warnings
  })
}
