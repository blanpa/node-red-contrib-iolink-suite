'use strict'
const { err, CODES } = require('./errors')
const { decodeLayout } = require('./codec/decode')
const { encodeLayout } = require('./codec/encode')

/**
 * The parsed device: identity, process data layouts, ISDU parameters, events -
 * plus the decode/encode entry points that use them.
 */
class IoddDevice {
  constructor (parts) {
    Object.assign(this, parts)
  }

  /** Every process data layout the file declares, with its selecting condition. */
  get variants () {
    return this.processData.map(v => ({
      id: v.id,
      condition: v.condition,
      inOctets: v.in ? v.in.octetLength : null,
      outOctets: v.out ? v.out.octetLength : null
    }))
  }

  /**
   * Pick one process data layout.
   *
   * Devices that change their layout with a parameter declare several, each
   * guarded by a <Condition> on an ISDU variable. Pass the id directly, or the
   * current parameter value as `{ conditions: { V_ProcessDataSelect: 2 } }`.
   * With several candidates and nothing to choose by, this throws rather than
   * picking the first - a wrong layout decodes to plausible, wrong numbers.
   */
  selectVariant (opts = {}) {
    const list = this.processData
    if (!list.length) {
      throw err(CODES.DECODE, `${this.describe()} declares no process data`)
    }
    if (opts.variant !== undefined && opts.variant !== null) {
      const hit = list.find(v => v.id === opts.variant)
      if (!hit) {
        throw err(CODES.BROKEN_REF,
          `no process data variant "${opts.variant}"; available: ${list.map(v => v.id).join(', ')}`,
          { requested: opts.variant, available: list.map(v => v.id) })
      }
      return hit
    }
    if (list.length === 1) return list[0]

    // Conditions given when the file was parsed act as defaults, so a caller
    // that already stated how the device is parameterised need not repeat it.
    const conditions = { ...this.conditions, ...opts.conditions }
    const matches = list.filter(v => {
      if (!v.condition) return false
      const supplied = conditions[v.condition.variableId] ?? conditions[v.condition.index]
      if (supplied === undefined) return false
      return String(supplied) === String(v.condition.value)
    })
    if (matches.length === 1) return matches[0]

    const described = list.map(v => v.condition
      ? `${v.id} (when ${v.condition.variableId}${v.condition.index !== undefined ? `/index ${v.condition.index}` : ''} = ${v.condition.value})`
      : `${v.id} (no condition)`)
    throw err(CODES.AMBIGUOUS_VARIANT,
      `${this.describe()} has ${list.length} process data layouts and none was selected. ` +
      `Pass { variant: "<id>" } or the current parameter value via { conditions: { ... } }. ` +
      `Candidates: ${described.join('; ')}`,
      { variants: this.variants })
  }

  /** The input or output layout of the selected variant. */
  layout (direction, opts = {}) {
    const variant = this.selectVariant(opts)
    const layout = direction === 'out' ? variant.out : variant.in
    if (!layout) {
      throw err(CODES.DECODE,
        `variant "${variant.id}" has no process data ${direction === 'out' ? 'output' : 'input'}`,
        { variantId: variant.id, direction })
    }
    return layout
  }

  /** Decode process data input (device -> master). */
  decodeIn (raw, opts = {}) {
    return decodeLayout(raw, this.layout('in', opts), opts)
  }

  /** Decode process data output, e.g. to read back what was written. */
  decodeOut (raw, opts = {}) {
    return decodeLayout(raw, this.layout('out', opts), opts)
  }

  /** Encode process data output (master -> device). */
  encodeOut (values, opts = {}) {
    return encodeLayout(values, this.layout('out', opts), opts)
  }

  /** Look up an ISDU parameter by name, id or index. */
  variable (selector) {
    if (typeof selector === 'number') return this.variables.find(v => v.index === selector)
    return this.variables.find(v => v.id === selector) ||
      this.variables.find(v => v.name === selector) ||
      this.variables.find(v => v.name && v.name.toLowerCase() === String(selector).toLowerCase())
  }

  /** Look up a declared event by code. */
  event (code) {
    const n = typeof code === 'string' ? Number.parseInt(code, code.startsWith('0x') ? 16 : 10) : code
    return this.events.find(e => e.code === n)
  }

  /** Short human-readable identification, used in error messages. */
  describe () {
    const { vendorName, deviceName, deviceId, vendorId } = this.identity
    const product = this.identity.variants[0] && this.identity.variants[0].productId
    return [vendorName, product || deviceName, `(vendorId ${vendorId}, deviceId ${deviceId})`]
      .filter(Boolean).join(' ')
  }

  toJSON () {
    return {
      identity: this.identity,
      communication: this.communication,
      processData: this.processData,
      variables: this.variables,
      events: this.events,
      language: this.language,
      warnings: this.warnings
    }
  }
}

module.exports = { IoddDevice }
