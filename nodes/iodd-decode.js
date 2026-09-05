'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd } = require('../lib/iodd')
const { extractIodd } = require('../lib/iodd/zip')
const { fail, shorten, safeJson } = require('../lib/runtime')

/** How many message-supplied IODDs one node keeps parsed. */
const MESSAGE_IODD_CACHE = 4

module.exports = function (RED) {
  /**
   * Decode (or encode) raw IO-Link bytes against an IODD, with no master
   * connection at all.
   *
   * This is the node for everyone whose process data already arrives by some
   * other route - PROFINET, EtherNet/IP, Modbus, OPC UA, an MQTT bridge, a
   * PLC. Feed it the bytes, point it at an IODD, get engineering values.
   */
  function IoddDecodeNode (config) {
    RED.nodes.createNode(this, config)
    const node = this

    let device = null
    let loadError = null
    // Parsing an IODD costs orders of magnitude more than decoding a block of
    // process data, so a flow that sends the same msg.iodd with every message -
    // the documented way to serve several device types from one node - must not
    // re-read and re-parse it every time. Keyed by the source itself, since
    // that is what decides the result; a handful of entries covers the case
    // this exists for without holding a library of XML in memory.
    const fromMessage = new Map()

    function parseOptions () {
      return {
        language: config.language || 'en',
        keyStyle: config.keyStyle || 'preserve',
        conditions: safeJson(config.conditions)
      }
    }

    function load () {
      device = null
      loadError = null
      const source = config.iodd && String(config.iodd).trim()
      if (!source) {
        loadError = new Error('no IODD configured: set a file path, or send one as msg.iodd')
        // Say so on the node now: waiting for the first message to reveal a
        // misconfiguration means finding it in production, not at deploy time.
        node.status({ fill: 'red', shape: 'ring', text: 'no IODD configured' })
        return
      }
      try {
        device = parseIodd(readIodd(source), parseOptions())
        const warn = device.warnings.length
        node.status(warn
          ? { fill: 'yellow', shape: 'dot', text: `${short(device)} (${warn} warning${warn === 1 ? '' : 's'})` }
          : { fill: 'green', shape: 'dot', text: short(device) })
      } catch (e) {
        loadError = e
        node.status({ fill: 'red', shape: 'ring', text: shorten(e.message) })
      }
    }

    load()

    node.on('input', function (msg, send, done) {
      try {
        // An IODD supplied on the message wins, so one node can serve several
        // device types driven by the flow.
        let active = device
        if (msg.iodd) active = parseFromMessage(msg.iodd)
        if (!active) throw loadError || new Error('no IODD loaded')

        const direction = (msg.direction || config.direction || 'in').toLowerCase()
        const opts = {
          variant: msg.variant || config.variant || undefined,
          conditions: msg.conditions || undefined,
          enums: config.enums === 'text' ? 'text' : undefined,
          strictLength: Boolean(config.strictLength)
        }

        if (config.mode === 'encode') {
          const buf = active.encodeOut(msg.payload || {}, opts)
          send({ ...msg, payload: buf.toString('hex'), iolink: { octets: buf.length } })
          node.status({ fill: 'green', shape: 'dot', text: `encoded ${buf.length} octets` })
          return done && done()
        }

        const raw = msg.payload
        if (raw === undefined || raw === null || raw === '') {
          throw Object.assign(new Error('msg.payload holds no data to decode'),
            { code: 'IOLINK_NO_DATA' })
        }
        const layout = active.layout(direction, opts)
        const { payload, meta } = direction === 'out'
          ? active.decodeOut(raw, opts)
          : active.decodeIn(raw, opts)

        node.status({
          fill: 'green',
          shape: 'dot',
          text: `${Object.keys(payload).length} values`
        })
        send({
          ...msg,
          payload,
          meta,
          device: {
            vendor: active.identity.vendorName,
            vendorId: active.identity.vendorId,
            deviceId: active.identity.deviceId,
            product: (active.identity.variants[0] || {}).productId || active.identity.deviceName
          },
          iolink: {
            raw: typeof raw === 'string' ? raw : Buffer.from(raw).toString('hex'),
            layout: layout.id,
            octets: layout.octetLength,
            ...(active.warnings.length ? { warnings: active.warnings } : {})
          },
          timestamp: new Date().toISOString()
        })
        if (done) done()
      } catch (e) {
        // The same reporting as every other node in the suite: a short status
        // on the node, and an error prefixed with the code a Catch node can
        // branch on whichever node it came from.
        fail(node, msg, e, done)
      }
    })

    /** Parse an IODD sent on a message, reusing the last few. */
    function parseFromMessage (source) {
      const key = typeof source === 'string' ? source : JSON.stringify(source)
      const hit = fromMessage.get(key)
      if (hit) {
        // Re-inserting keeps the ones actually in use, so a flow alternating
        // between two device types does not evict them in turn.
        fromMessage.delete(key)
        fromMessage.set(key, hit)
        return hit
      }
      const parsed = parseIodd(
        typeof source === 'string' && !source.trimStart().startsWith('<')
          ? readIodd(source)
          : source,
        parseOptions())
      fromMessage.set(key, parsed)
      if (fromMessage.size > MESSAGE_IODD_CACHE) {
        fromMessage.delete(fromMessage.keys().next().value)
      }
      return parsed
    }

    node.on('close', function (done) {
      fromMessage.clear()
      done()
    })
  }

  /** Accept an IODD as a path to .xml or .zip, or as XML text. */
  function readIodd (source) {
    if (source.trimStart().startsWith('<')) return source
    const file = path.resolve(source)
    if (file.toLowerCase().endsWith('.zip')) return extractIodd(fs.readFileSync(file)).xml
    return fs.readFileSync(file, 'utf8')
  }

  const short = d =>
    `${d.identity.vendorName} ${(d.identity.variants[0] || {}).productId || d.identity.deviceName || ''}`.slice(0, 32)

  RED.nodes.registerType('iodd-decode', IoddDecodeNode)
}
