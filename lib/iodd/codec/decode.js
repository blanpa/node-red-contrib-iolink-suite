'use strict'
const { readBits, readOctets, toSigned, toBuffer } = require('./bits')
const { applyScale } = require('./scale')
const { err, CODES } = require('../errors')

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = -MAX_SAFE

/** Numbers stay numbers while that is lossless; wider values become BigInt. */
function narrow (value, bigIntMode) {
  if (bigIntMode === 'always') return value
  if (value <= MAX_SAFE && value >= MIN_SAFE) return Number(value)
  return bigIntMode === 'never' ? Number(value) : value
}

function renderOctets (buf, style) {
  switch (style) {
    case 'buffer': return buf
    case 'array': return Array.from(buf)
    case 'base64': return buf.toString('base64')
    default: return buf.toString('hex')
  }
}

/** Trailing NULs pad fixed-length IO-Link strings; spaces are common too. */
const trimString = s => s.replace(/\0+$/, '').replace(/\s+$/, '')

/** Decode a single item out of the raw block. */
function decodeItem (buf, item, opts = {}) {
  const { bitOffset, bitLength, type } = item
  switch (type) {
    case 'Boolean':
      return readBits(buf, bitOffset, 1) === 1n

    case 'UInteger':
      return narrow(readBits(buf, bitOffset, bitLength), opts.bigInt)

    case 'Integer':
      return narrow(toSigned(readBits(buf, bitOffset, bitLength), bitLength), opts.bigInt)

    case 'Float32': {
      const raw = readBits(buf, bitOffset, 32)
      const b = Buffer.alloc(4)
      b.writeUInt32BE(Number(raw))
      return b.readFloatBE(0)
    }

    case 'TimeSpan':
    case 'Time':
      return narrow(toSigned(readBits(buf, bitOffset, bitLength), bitLength), opts.bigInt)

    case 'String': {
      const octets = readOctets(buf, bitOffset, bitLength)
      const encoding = (item.encoding || 'UTF-8').toUpperCase() === 'ASCII' ? 'ascii' : 'utf8'
      return trimString(octets.toString(encoding))
    }

    case 'OctetString':
      return renderOctets(readOctets(buf, bitOffset, bitLength), opts.octets)

    default:
      throw err(CODES.DECODE, `cannot decode datatype "${type}"`, { type })
  }
}

/** Resolve an enum member's text for a raw value, if the item declares one. */
function enumTextFor (item, rawValue) {
  if (!item.values || !item.values.length) return undefined
  const needle = typeof rawValue === 'boolean' ? String(rawValue) : String(rawValue)
  const hit = item.values.find(v => String(v.value) === needle)
  return hit ? hit.name : undefined
}

/**
 * Decode a whole process data block against a layout.
 *
 * Returns `{ payload, meta }`: payload is flat `key -> value`, meta carries the
 * unit, type and range for each key. Metadata sits beside the values rather
 * than wrapping them, so payload can be forwarded as-is.
 */
function decodeLayout (raw, layout, opts = {}) {
  let buf = toBuffer(raw)
  const expected = layout.octetLength ?? Math.ceil(layout.bitLength / 8)

  if (buf.length < expected) {
    throw err(CODES.DECODE,
      `process data too short: got ${buf.length} octet${buf.length === 1 ? '' : 's'}, ` +
      `layout "${layout.name || layout.id}" needs ${expected}`,
      { got: buf.length, expected, layoutId: layout.id })
  }
  if (buf.length > expected) {
    if (opts.strictLength) {
      throw err(CODES.DECODE,
        `process data too long: got ${buf.length} octets, layout needs ${expected}`,
        { got: buf.length, expected, layoutId: layout.id })
    }
    // Some masters pad the reply. The process data block is the leading
    // octets; anchoring on the buffer's end instead would shift every field.
    buf = buf.subarray(0, expected)
  }

  const payload = {}
  const meta = {}
  const errors = []

  for (const item of layout.items) {
    let value
    try {
      value = decodeItem(buf, item, opts)
    } catch (e) {
      if (opts.partial) { errors.push({ key: item.key, error: e.message }); continue }
      throw e
    }
    const text = enumTextFor(item, value)
    const scaled = applyScale(value, item)

    payload[item.key] = opts.enums === 'text' && text !== undefined ? text : scaled

    const entry = { type: item.type }
    if (item.unit !== undefined) entry.unit = item.unit
    if (item.unitName !== undefined) entry.unitName = item.unitName
    if (item.min !== undefined) entry.min = item.min
    if (item.max !== undefined) entry.max = item.max
    if (item.description !== undefined) entry.description = item.description
    if (text !== undefined) entry.text = text
    if (scaled !== value) entry.raw = value
    entry.subindex = item.subindex
    entry.bitOffset = item.bitOffset
    entry.bitLength = item.bitLength
    meta[item.key] = entry
  }

  const result = { payload, meta }
  if (errors.length) result.errors = errors
  return result
}

module.exports = { decodeLayout, decodeItem, enumTextFor }
