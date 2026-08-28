'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd, IoddError } = require('../lib/iodd')
const { extractIodd } = require('../lib/iodd/zip')

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
        node.status({ fill: 'red', shape: 'ring', text: trim(e.message) })
      }
    }

    load()

    node.on('input', function (msg, send, done) {
      try {
        // An IODD supplied on the message wins, so one node can serve several
        // device types driven by the flow.
        let active = device
        if (msg.iodd) {
          active = parseIodd(typeof msg.iodd === 'string' && !msg.iodd.trimStart().startsWith('<')
            ? readIodd(msg.iodd)
            : msg.iodd, parseOptions())
        }
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
        // Every node in the suite prefixes the code, so a Catch node can branch
        // on it whichever node the error came from.
        const text = (e instanceof IoddError || e.code) ? `${e.code}: ${e.message}` : e.message
        node.status({ fill: 'red', shape: 'ring', text: trim(e.message) })
        if (done) done(Object.assign(e, { message: text }))
        else node.error(text, msg)
      }
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
  const trim = (t, n = 40) => (t.length > n ? t.slice(0, n - 1) + '…' : t)
  const safeJson = raw => {
    if (!raw || typeof raw === 'object') return raw || undefined
    try { return JSON.parse(raw) } catch { return undefined }
  }

  RED.nodes.registerType('iodd-decode', IoddDecodeNode)
}
