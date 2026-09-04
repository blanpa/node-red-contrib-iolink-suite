'use strict'
const {
  sharedIdentityCache, resolveDevice, shapeOutput, splitOutput, fail, resolvePorts,
  startPolling, asTick, safeJson, withCode
} = require('../lib/runtime')

module.exports = function (RED) {
  /**
   * Read process data in from one port, or from several, and decode it through
   * each device's IODD.
   *
   * Triggered by an incoming message, or on an interval. The port's identity is
   * cached briefly: re-scanning vendorId and deviceId before every read would
   * triple the traffic to the master for no benefit, but pinning it forever
   * would survive a device being swapped, so it expires.
   *
   * One port produces the flat message it always did. Several produce one
   * message keyed by port, because a rack read in one go is one reading of the
   * plant and splitting it into four messages would leave a flow correlating
   * them again. Ports are read one after another rather than at once: a master
   * is a small embedded device on the end of a wire, and four requests in
   * flight is how you find its limit.
   */
  function IolinkReadNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)

    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }

    const identityCache = sharedIdentityCache(master)
    const identityTtl = Number(config.identityTtl) || 30000
    const selected = Array.isArray(config.values) ? config.values.filter(Boolean) : []
    const splitMode = config.output === 'split'
    let stopPolling = null
    let warnedMissing = false

    /**
     * A selected value the device does not carry is worth one warning.
     *
     * The selection is stored by key, and a firmware update, a changed key
     * style on the master or a different device on the port can leave a key
     * with nothing to pick. Silently emitting the rest, or nothing, looks like
     * a sensor that stopped reporting; saying it once names the cause. Once,
     * because on a polled node it would otherwise repeat every tick.
     */
    function warnMissing (port, payload) {
      if (warnedMissing) return
      const missing = selected.filter(key => !(key in payload))
      if (!missing.length) return
      warnedMissing = true
      const has = Object.keys(payload).join(', ') || 'nothing'
      node.warn(`port ${port}: the selected value${missing.length === 1 ? '' : 's'} ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this device's ` +
        `process data (it has: ${has}); rescan the port in the editor`)
    }

    async function readPort (port) {
      const { device, status } = await resolveDevice(master, port, {
        identityCache,
        identityTtl,
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

      if (selected.length) warnMissing(port, payload)
      const filtered = selected.length
        ? {
            payload: pick(payload, selected),
            meta: pick(meta, selected)
          }
        : { payload, meta }

      return shapeOutput({
        ...filtered,
        device,
        status,
        port,
        raw,
        layout,
        extra: device.warnings.length ? { warnings: device.warnings } : undefined
      })
    }

    /**
     * Where a split message's topic comes from.
     *
     * With one port this is what it has always been. With several, the port has
     * to appear in the topic even when a prefix is configured: two devices on
     * one rack routinely carry the same value name, and a shared prefix would
     * publish both of them to one topic.
     */
    function topicFor (port, portCount) {
      const prefix = config.topicPrefix
      if (!prefix) return `iolink/port${port}`
      return portCount === 1 ? prefix : `${prefix}/port${port}`
    }

    async function readOnce (msg, send, done) {
      let ports
      try {
        ports = resolvePorts(RED, node, msg, config)
      } catch (e) {
        return fail(node, msg, e, done)
      }

      const read = []
      const errors = {}
      for (const port of ports) {
        try {
          read.push(await readPort(port))
        } catch (e) {
          // One port must not cost the others their reading: an empty socket in
          // the middle of a rack is a normal state of a plant, not a failed
          // read. Reading a single port has nothing to salvage, so there it
          // stays an error and reaches a Catch node as it always did.
          if (ports.length === 1) return fail(node, msg, e, done)
          errors[port] = withCode(e).message
        }
      }

      if (!read.length) {
        return fail(node, msg, Object.assign(
          new Error(`no port answered — ${Object.values(errors).join('; ')}`),
          { code: 'IOLINK_NO_DATA', errors }), done)
      }

      const body = ports.length === 1 ? read[0] : byPort(read)
      if (Object.keys(errors).length) body.errors = errors

      node.status({ fill: 'green', shape: 'dot', text: describe(read, ports, errors) })

      if (splitMode) {
        const parts = read.flatMap(entry =>
          splitOutput(entry, topicFor(entry.device.port, ports.length), msg))
        // The ports that did not answer are named on every part: a message
        // per value has no other place to carry them, and the status line's
        // "2 of 3 ports" says that one is missing but not which.
        if (Object.keys(errors).length) parts.forEach(part => { part.errors = errors })
        send([parts])
      } else {
        send({ ...msg, ...body })
      }
      if (done) done()
    }

    node.on('input', (msg, send, done) => { readOnce(msg, send, done) })

    const interval = Number(config.interval) || 0
    if (interval > 0) {
      node.status({ fill: 'grey', shape: 'ring', text: `polling every ${interval} ms` })
      stopPolling = startPolling(node, interval, asTick(readOnce))
    }

    node.on('close', function (done) {
      if (stopPolling) stopPolling()
      done()
    })
  }

  const pick = (obj, keys) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)))

  /**
   * Several ports, as one message.
   *
   * Every part of the single-port message keeps its name and gains a port key
   * above it, so `msg.payload[1].Temperature` is the same value the single-port
   * form calls `msg.payload.Temperature`. A flow that grows from one port to
   * two then changes in one place rather than everywhere.
   */
  const byPort = entries => ({
    payload: Object.fromEntries(entries.map(e => [e.device.port, e.payload])),
    meta: Object.fromEntries(entries.map(e => [e.device.port, e.meta])),
    device: Object.fromEntries(entries.map(e => [e.device.port, e.device])),
    iolink: Object.fromEntries(entries.map(e => [e.device.port, e.iolink])),
    timestamp: new Date().toISOString()
  })

  function describe (read, ports, errors) {
    const values = read.reduce((sum, e) => sum + Object.keys(e.payload).length, 0)
    const plural = values === 1 ? '' : 's'
    if (ports.length === 1) return `port ${ports[0]}: ${values} value${plural}`
    const failed = Object.keys(errors).length
    const heard = `${read.length} of ${ports.length} ports`
    return failed ? `${heard}: ${values} value${plural}` : `${ports.length} ports: ${values} value${plural}`
  }

  RED.nodes.registerType('iolink-read', IolinkReadNode)
}
