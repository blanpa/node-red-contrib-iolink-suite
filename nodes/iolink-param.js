'use strict'
const { PortIdentityCache, resolveDevice, fail, evaluate, resolvePort } = require('../lib/runtime')
const { decodeItem, encodeItem, applyScale, removeScale } = require('../lib/iodd')

module.exports = function (RED) {
  /**
   * Read and write ISDU parameters by their name in the IODD, rather than by
   * index and subindex.
   *
   * The master returns an ISDU as raw hex; the IODD says what those bytes mean,
   * including scaling and enumerations, so "Switch point" reads back as 23.47 °C
   * instead of 0x092B.
   */
  function IolinkParamNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)
    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }
    const identityCache = new PortIdentityCache(Number(config.identityTtl) || 30000)

    node.on('input', async function (msg, send, done) {
      const action = (msg.action || config.action || 'read').toLowerCase()
      const selector = evaluate(RED, node, msg, config.parameter, config.parameterType,
        msg.parameter !== undefined ? msg.parameter : config.parameter)

      try {
        const port = resolvePort(RED, node, msg, config)
        const { device } = await resolveDevice(master, port, {
          identityCache,
          vendorId: config.vendorId ? Number(config.vendorId) : undefined,
          deviceId: config.deviceId ? Number(config.deviceId) : undefined
        })

        const variable = findVariable(device, selector)
        const subindex = msg.subindex !== undefined
          ? Number(msg.subindex)
          : (config.subindex === '' || config.subindex === undefined ? 0 : Number(config.subindex))
        const item = itemFor(variable, subindex)

        if (action === 'write') {
          if (variable.access === 'ro') {
            throw Object.assign(
              new Error(`"${variable.name}" (index ${variable.index}) is read-only`),
              { code: 'IOLINK_READ_ONLY' })
          }
          const hex = encodeParameter(item, msg.payload)
          await master.adapter.writeIsdu(port, variable.index, subindex, hex)
          node.status({ fill: 'green', shape: 'dot', text: `wrote ${variable.name}` })
          send({ ...msg, payload: msg.payload, iolink: rawInfo(variable, subindex, hex) })
        } else {
          if (variable.access === 'wo') {
            throw Object.assign(
              new Error(`"${variable.name}" (index ${variable.index}) is write-only`),
              { code: 'IOLINK_WRITE_ONLY' })
          }
          const hex = await master.adapter.readIsdu(port, variable.index, subindex)
          const value = decodeParameter(item, hex)
          node.status({ fill: 'green', shape: 'dot', text: `${variable.name} = ${format(value)}` })
          send({
            ...msg,
            payload: value.value,
            meta: value.meta,
            iolink: rawInfo(variable, subindex, hex),
            device: {
              vendor: device.identity.vendorName,
              product: (device.identity.variants[0] || {}).productId,
              port
            },
            timestamp: new Date().toISOString()
          })
        }
        if (done) done()
      } catch (e) {
        fail(node, msg, e, done)
      }
    })

    node.on('close', function (done) { identityCache.clear(); done() })
  }

  function findVariable (device, selector) {
    if (selector === undefined || selector === null || selector === '') {
      throw Object.assign(new Error('no parameter selected'), { code: 'IOLINK_NO_PARAMETER' })
    }
    const variable = device.variable(
      /^\d+$/.test(String(selector)) ? Number(selector) : selector)
    if (!variable) {
      const known = device.variables.slice(0, 12).map(v => `${v.index} ${v.name}`).join(', ')
      throw Object.assign(
        new Error(`no parameter "${selector}" in this device's IODD. Known: ${known}…`),
        { code: 'IOLINK_UNKNOWN_PARAMETER' })
    }
    if (variable.unsupported) {
      throw Object.assign(
        new Error(`parameter "${variable.name}": ${variable.unsupported}`),
        { code: 'IOLINK_UNSUPPORTED_PARAMETER' })
    }
    return variable
  }

  /**
   * ISDU reads return only the addressed object, so a record subindex arrives
   * as its own little block starting at bit 0 - not at its offset within the
   * whole record.
   */
  function itemFor (variable, subindex) {
    if (!variable.items || !variable.items.length || subindex === 0) {
      return {
        key: variable.name,
        name: variable.name,
        type: variable.type,
        bitLength: variable.bitLength,
        bitOffset: 0,
        encoding: variable.encoding,
        gradient: variable.gradient,
        offset: variable.offset,
        decimals: variable.decimals,
        unit: variable.unit,
        values: variable.values,
        min: variable.min,
        max: variable.max,
        wholeRecord: Boolean(variable.items && variable.items.length)
      }
    }
    const item = variable.items.find(i => i.subindex === subindex)
    if (!item) {
      const known = variable.items.map(i => i.subindex).join(', ')
      throw Object.assign(
        new Error(`"${variable.name}" has no subindex ${subindex}; it has ${known}`),
        { code: 'IOLINK_UNKNOWN_SUBINDEX' })
    }
    return { ...item, bitOffset: 0 }
  }

  function decodeParameter (item, hex) {
    if (hex === null || hex === undefined) {
      throw Object.assign(new Error('the master returned no value for this parameter'),
        { code: 'IOLINK_NO_DATA' })
    }
    const buf = Buffer.from(hex, 'hex')
    if (item.wholeRecord) {
      // Reading a record at subindex 0 gives the raw block; the caller asked
      // for the object, not a field, so hand back the bytes unchanged.
      return { value: hex, meta: { type: 'Record', raw: hex, octets: buf.length } }
    }
    // A string field is declared at its maximum length but often comes back
    // shorter, so decode against what actually arrived.
    const bitLength = (item.type === 'String' || item.type === 'OctetString')
      ? buf.length * 8
      : item.bitLength
    const raw = decodeItem(buf, { ...item, bitOffset: 0, bitLength })
    const scaled = applyScale(raw, item)
    const text = item.values && item.values.find(v => String(v.value) === String(raw))
    const meta = { type: item.type, raw }
    if (item.unit) meta.unit = item.unit
    if (item.min !== undefined) meta.min = item.min
    if (item.max !== undefined) meta.max = item.max
    if (text) meta.text = text.name
    return { value: scaled, meta }
  }

  function encodeParameter (item, value) {
    if (item.wholeRecord) {
      if (typeof value !== 'string') {
        throw Object.assign(
          new Error(`"${item.name}" is a record; write it as a hex string, or address a subindex`),
          { code: 'IOLINK_BAD_PAYLOAD' })
      }
      return value.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    }
    let raw = value
    if (item.values && typeof value === 'string') {
      const hit = item.values.find(v => v.name === value)
      if (hit) raw = item.type === 'Boolean' ? hit.value === 'true' : Number(hit.value)
    }
    if (typeof raw === 'number') {
      if (item.min !== undefined && raw < item.min) {
        throw Object.assign(
          new Error(`${raw} is below the declared minimum ${item.min} for "${item.name}"`),
          { code: 'IOLINK_OUT_OF_RANGE' })
      }
      if (item.max !== undefined && raw > item.max) {
        throw Object.assign(
          new Error(`${raw} is above the declared maximum ${item.max} for "${item.name}"`),
          { code: 'IOLINK_OUT_OF_RANGE' })
      }
      raw = removeScale(raw, item)
    }
    const octets = Math.ceil(item.bitLength / 8)
    const buf = encodeItem(Buffer.alloc(octets), { ...item, bitOffset: 0 }, raw)
    return buf.toString('hex')
  }

  const rawInfo = (variable, subindex, hex) => ({
    index: variable.index,
    subindex,
    parameter: variable.name,
    access: variable.access,
    raw: hex
  })

  const format = v => {
    const text = v.meta && v.meta.text ? v.meta.text : v.value
    const unit = v.meta && v.meta.unit ? ` ${v.meta.unit}` : ''
    return `${String(text).slice(0, 20)}${unit}`
  }

  RED.nodes.registerType('iolink-param', IolinkParamNode)
}
