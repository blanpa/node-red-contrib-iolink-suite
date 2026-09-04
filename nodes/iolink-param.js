'use strict'
const {
  sharedIdentityCache, resolveDevice, describeDevice, fail, evaluate, resolvePort, withCode,
  parseHex
} = require('../lib/runtime')
const { decodeItem, encodeItem, applyScale, removeScale } = require('../lib/iodd')

module.exports = function (RED) {
  /**
   * Read and write ISDU parameters by their name in the IODD, rather than by
   * index and subindex.
   *
   * The master returns an ISDU as raw hex; the IODD says what those bytes mean,
   * including scaling and enumerations, so "Switch point" reads back as 23.47 °C
   * instead of 0x092B.
   *
   * One parameter or several: a list produces one message keyed by parameter
   * name, in the same way the read node keys a rack by port. Each ISDU is its
   * own request whatever happens, so this is about the shape of the flow rather
   * than about saving traffic - one node and one message instead of five nodes
   * wired in a line and a join to put them back together.
   */
  function IolinkParamNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)
    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }
    const identityCache = sharedIdentityCache(master)
    const identityTtl = Number(config.identityTtl) || 30000

    node.on('input', async function (msg, send, done) {
      const action = (msg.action || config.action || 'read').toLowerCase()
      // The message wins over the dialog, as the help says it does: a flow that
      // sets msg.parameter has decided, whatever the node was left set to.
      const asked = msg.parameter !== undefined && msg.parameter !== null && msg.parameter !== ''
        ? msg.parameter
        : evaluate(RED, node, msg, config.parameter, config.parameterType, undefined)
      const selectors = parseSelectors(asked)

      /** One parameter, read or written. */
      async function one (device, port, selector, subindex) {
        const variable = findVariable(device, selector)
        const item = itemFor(variable, subindex)

        if (action === 'write') {
          if (variable.access === 'ro') {
            throw Object.assign(
              new Error(`"${variable.name}" (index ${variable.index}) is read-only`),
              { code: 'IOLINK_READ_ONLY' })
          }
          const value = valueToWrite(msg.payload, selector, variable, selectors.length)
          const hex = encodeParameter(item, value)
          await master.adapter.writeIsdu(port, variable.index, subindex, hex)
          return { name: variable.name, payload: value, iolink: rawInfo(variable, subindex, hex) }
        }

        if (variable.access === 'wo') {
          throw Object.assign(
            new Error(`"${variable.name}" (index ${variable.index}) is write-only`),
            { code: 'IOLINK_WRITE_ONLY' })
        }
        const hex = await master.adapter.readIsdu(port, variable.index, subindex)
        const value = decodeParameter(item, hex)
        return {
          name: variable.name,
          payload: value.value,
          meta: value.meta,
          iolink: rawInfo(variable, subindex, hex)
        }
      }

      try {
        if (!selectors.length) {
          throw Object.assign(new Error('no parameter selected'), { code: 'IOLINK_NO_PARAMETER' })
        }
        const port = resolvePort(RED, node, msg, config)
        const subindex = resolveSubindex(msg, config)
        const { device, status } = await resolveDevice(master, port, {
          identityCache,
          identityTtl,
          vendorId: config.vendorId ? Number(config.vendorId) : undefined,
          deviceId: config.deviceId ? Number(config.deviceId) : undefined
        })

        const results = []
        const errors = {}
        for (const selector of selectors) {
          try {
            results.push(await one(device, port, selector, subindex))
          } catch (e) {
            // One parameter a device will not give up must not cost the others.
            // With a single one asked for there is nothing to salvage, so it
            // reaches a Catch node exactly as it always did.
            if (selectors.length === 1) throw e
            errors[selector] = withCode(e).message
          }
        }
        if (!results.length) {
          throw Object.assign(
            new Error(`no parameter answered — ${Object.values(errors).join('; ')}`),
            { code: 'IOLINK_NO_PARAMETER', errors })
        }

        const body = selectors.length === 1 ? flat(results[0]) : byName(results)
        if (Object.keys(errors).length) body.errors = errors
        node.status({ fill: 'green', shape: 'dot', text: say(action, results, selectors, errors) })

        // Same shape for read and write: a flow that logs or correlates on
        // device and timestamp should not have to special-case a write.
        send({
          ...msg,
          ...body,
          device: describeDevice(device, status, port),
          timestamp: new Date().toISOString()
        })
        if (done) done()
      } catch (e) {
        fail(node, msg, e, done)
      }
    })
  }

  /**
   * The subindex, from the message or the dialog.
   *
   * Anything that is not a small whole number is refused up front. Passed
   * through `Number()` unchecked, a typo arrived at the device as NaN and came
   * back as "has no subindex NaN", which describes the symptom, not the typo.
   */
  function resolveSubindex (msg, config) {
    const raw = msg.subindex !== undefined ? msg.subindex : config.subindex
    if (raw === undefined || raw === null || raw === '') return 0
    const subindex = Number(raw)
    if (!Number.isInteger(subindex) || subindex < 0 || subindex > 255) {
      throw Object.assign(
        new Error(`${JSON.stringify(raw)} is not a subindex (0 to 255)`),
        { code: 'IOLINK_BAD_SUBINDEX' })
    }
    return subindex
  }

  /**
   * The parameters asked for.
   *
   * A comma-separated string is how a list is typed into the dialog; an array
   * is how one arrives from a message. A name holding a comma can therefore
   * only be asked for through a message, which is the price of a field people
   * can type a list into.
   */
  function parseSelectors (asked) {
    if (Array.isArray(asked)) {
      return asked.map(entry => String(entry).trim()).filter(Boolean)
    }
    if (asked === undefined || asked === null) return []
    return String(asked).split(',').map(entry => entry.trim()).filter(Boolean)
  }

  /**
   * Which part of the payload is meant for this parameter.
   *
   * Writing one parameter takes the payload as it stands. Writing several needs
   * to be told which value belongs to which, so the payload is an object keyed
   * by parameter - under the name it is asked for, or the name the IODD gives
   * it. A parameter with nothing to write is an error rather than a silent
   * skip: it is a flow sending the wrong shape, and writing the others while
   * dropping one quietly is how a machine ends up half configured.
   */
  function valueToWrite (payload, selector, variable, count) {
    if (count === 1) return payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw Object.assign(
        new Error('writing several parameters needs an object payload keyed by parameter, ' +
          `got ${Array.isArray(payload) ? 'an array' : typeof payload}`),
        { code: 'IOLINK_BAD_PAYLOAD' })
    }
    if (payload[selector] !== undefined) return payload[selector]
    if (payload[variable.name] !== undefined) return payload[variable.name]
    throw Object.assign(
      new Error(`the payload carries nothing for "${variable.name}"`),
      { code: 'IOLINK_BAD_PAYLOAD' })
  }

  /** One parameter, in the shape this node has always emitted. */
  function flat (result) {
    const out = { payload: result.payload }
    if (result.meta !== undefined) out.meta = result.meta
    out.iolink = result.iolink
    return out
  }

  /**
   * Several parameters, keyed by the name the IODD gives them - so a flow that
   * asked by index still gets readable keys, and asking by name or by index
   * produces the same message.
   */
  function byName (results) {
    const out = {
      payload: Object.fromEntries(results.map(r => [r.name, r.payload]))
    }
    const withMeta = results.filter(r => r.meta !== undefined)
    if (withMeta.length) out.meta = Object.fromEntries(withMeta.map(r => [r.name, r.meta]))
    out.iolink = Object.fromEntries(results.map(r => [r.name, r.iolink]))
    return out
  }

  function say (action, results, selectors, errors) {
    if (selectors.length === 1) {
      const only = results[0]
      return action === 'write'
        ? `wrote ${only.name}`
        : `${only.name} = ${format({ value: only.payload, meta: only.meta })}`
    }
    const verb = action === 'write' ? 'wrote' : 'read'
    return Object.keys(errors).length
      ? `${verb} ${results.length} of ${selectors.length}`
      : `${verb} ${results.length} parameters`
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
    hex = parseHex(hex, `the value the master returned for "${item.name}"`)
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
      return parseHex(value, `the record for "${item.name}"`)
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
