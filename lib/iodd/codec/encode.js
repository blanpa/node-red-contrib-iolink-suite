'use strict'
const { writeBits, writeOctets, fromSigned, toBuffer } = require('./bits')
const { removeScale } = require('./scale')
const { err, CODES } = require('../errors')

/** Accept the enum's plain text as well as its raw value. */
function resolveEnum (item, value) {
  if (!item.values || !item.values.length) return value
  if (typeof value !== 'string') return value
  const byName = item.values.find(v => v.name === value)
  if (byName) {
    if (item.type === 'Boolean') return byName.value === 'true'
    return Number(byName.value)
  }
  return value
}

function encodeItem (buf, item, value) {
  const { bitOffset, bitLength, type } = item

  switch (type) {
    case 'Boolean': {
      const bit = value === true || value === 1 || value === '1' || value === 'true'
      return writeBits(buf, bitOffset, 1, bit ? 1n : 0n)
    }

    case 'UInteger': {
      const raw = BigInt(Math.round(Number(value)))
      if (raw < 0n) {
        throw err(CODES.ENCODE, `"${item.key}" is unsigned but got ${value}`, { key: item.key, value })
      }
      const limit = (1n << BigInt(bitLength)) - 1n
      if (raw > limit) {
        throw err(CODES.ENCODE,
          `"${item.key}" = ${value} does not fit in ${bitLength} unsigned bits (max ${limit})`,
          { key: item.key, value, bitLength })
      }
      return writeBits(buf, bitOffset, bitLength, raw)
    }

    case 'Integer':
    case 'TimeSpan':
    case 'Time': {
      const raw = BigInt(Math.round(Number(value)))
      const limit = 1n << BigInt(bitLength - 1)
      if (raw >= limit || raw < -limit) {
        throw err(CODES.ENCODE,
          `"${item.key}" = ${value} does not fit in ${bitLength} signed bits`,
          { key: item.key, value, bitLength })
      }
      return writeBits(buf, bitOffset, bitLength, fromSigned(raw, bitLength))
    }

    case 'Float32': {
      const b = Buffer.alloc(4)
      b.writeFloatBE(Number(value))
      return writeBits(buf, bitOffset, 32, BigInt(b.readUInt32BE(0)))
    }

    case 'String': {
      const encoding = (item.encoding || 'UTF-8').toUpperCase() === 'ASCII' ? 'ascii' : 'utf8'
      const octets = Buffer.from(String(value), encoding)
      const width = bitLength / 8
      if (octets.length > width) {
        throw err(CODES.ENCODE,
          `"${item.key}" needs ${octets.length} octets but the field holds ${width}`,
          { key: item.key, needed: octets.length, width })
      }
      return writeOctets(buf, bitOffset, bitLength, octets)
    }

    case 'OctetString': {
      const octets = toBuffer(value)
      const width = bitLength / 8
      if (octets.length > width) {
        throw err(CODES.ENCODE,
          `"${item.key}" needs ${octets.length} octets but the field holds ${width}`,
          { key: item.key, needed: octets.length, width })
      }
      return writeOctets(buf, bitOffset, bitLength, octets)
    }

    default:
      throw err(CODES.ENCODE, `cannot encode datatype "${type}"`, { type })
  }
}

/**
 * Encode values into a process data block.
 *
 * `opts.base` seeds the block with the device's current output data, so a flow
 * can set one bit of a valve manifold without zeroing the rest. Unknown keys
 * are rejected: silently dropping a misspelt tag would leave an actuator at a
 * value the flow believes it changed.
 */
function encodeLayout (values, layout, opts = {}) {
  const width = layout.octetLength ?? Math.ceil(layout.bitLength / 8)
  let buf = opts.base ? toBuffer(opts.base) : Buffer.alloc(width)
  if (buf.length !== width) {
    if (buf.length < width) {
      throw err(CODES.ENCODE,
        `base data is ${buf.length} octets but the layout needs ${width}`,
        { got: buf.length, expected: width })
    }
    buf = buf.subarray(buf.length - width)
  }

  const byKey = new Map(layout.items.map(item => [item.key, item]))
  const unknown = Object.keys(values).filter(k => !byKey.has(k))
  if (unknown.length && !opts.ignoreUnknown) {
    throw err(CODES.ENCODE,
      `no such process data value: ${unknown.map(k => `"${k}"`).join(', ')}. ` +
      `Known keys: ${[...byKey.keys()].map(k => `"${k}"`).join(', ')}`,
      { unknown, known: [...byKey.keys()] })
  }

  for (const [key, item] of byKey) {
    if (!(key in values)) continue
    let value = resolveEnum(item, values[key])
    if (!opts.ignoreRange && item.min !== undefined && typeof value === 'number' && value < item.min) {
      throw err(CODES.ENCODE, `"${key}" = ${value} is below the declared minimum ${item.min}`,
        { key, value, min: item.min })
    }
    if (!opts.ignoreRange && item.max !== undefined && typeof value === 'number' && value > item.max) {
      throw err(CODES.ENCODE, `"${key}" = ${value} is above the declared maximum ${item.max}`,
        { key, value, max: item.max })
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      value = removeScale(value, item)
    }
    buf = encodeItem(buf, item, value)
  }

  return buf
}

module.exports = { encodeLayout, encodeItem }
