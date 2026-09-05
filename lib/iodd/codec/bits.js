'use strict'
const { err, CODES } = require('../errors')

/**
 * Bit addressing for IO-Link process data.
 *
 * Process data travels as a big-endian octet string. IODD `bitOffset` counts
 * from the LEAST significant bit of the whole block - i.e. from the right-hand
 * end of the LAST octet - and grows leftwards. So in a 32 bit block,
 * `bitOffset="16" bitLength="16"` is the FIRST two octets on the wire.
 *
 * When the declared bitLength is not a multiple of 8 the block is padded to
 * whole octets and the payload is right-aligned, with the pad bits in the most
 * significant positions. Anchoring every read on the buffer's LSB therefore
 * handles padded and unpadded blocks with the same arithmetic.
 */

/** Interpret a buffer as one big-endian unsigned integer. */
function toBigInt (buf) {
  let v = 0n
  for (let i = 0; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i])
  return v
}

/** Render a big-endian unsigned integer back into a buffer of `byteLength`. */
function fromBigInt (value, byteLength) {
  const buf = Buffer.alloc(byteLength)
  let v = value
  for (let i = byteLength - 1; i >= 0; i--) {
    buf[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return buf
}

/** Read `bitLength` bits at `bitOffset` as an unsigned BigInt. */
function readBits (buf, bitOffset, bitLength) {
  const total = buf.length * 8
  if (!Number.isInteger(bitOffset) || bitOffset < 0) {
    throw err(CODES.DECODE, `bitOffset must be a non-negative integer, got ${bitOffset}`)
  }
  if (!Number.isInteger(bitLength) || bitLength <= 0) {
    throw err(CODES.DECODE, `bitLength must be a positive integer, got ${bitLength}`)
  }
  if (bitOffset + bitLength > total) {
    throw err(CODES.DECODE,
      `need ${bitOffset + bitLength} bits but only ${total} were supplied ` +
      `(${buf.length} octet${buf.length === 1 ? '' : 's'})`,
      { bitOffset, bitLength, available: total })
  }
  const mask = (1n << BigInt(bitLength)) - 1n
  return (toBigInt(buf) >> BigInt(bitOffset)) & mask
}

/** Write an unsigned BigInt into `buf` at `bitOffset`. Returns a new buffer. */
function writeBits (buf, bitOffset, bitLength, value) {
  const total = buf.length * 8
  if (bitOffset + bitLength > total) {
    throw err(CODES.ENCODE,
      `cannot write ${bitLength} bits at offset ${bitOffset} into ${total} bits`,
      { bitOffset, bitLength, available: total })
  }
  const mask = (1n << BigInt(bitLength)) - 1n
  const shift = BigInt(bitOffset)
  const all = (toBigInt(buf) & ~(mask << shift)) | ((BigInt(value) & mask) << shift)
  return fromBigInt(all, buf.length)
}

/**
 * Octet-aligned slice, used for StringT/OctetStringT which are always aligned.
 * Returns the octets in wire order (most significant first).
 */
function readOctets (buf, bitOffset, bitLength) {
  if (bitOffset % 8 !== 0 || bitLength % 8 !== 0) {
    throw err(CODES.DECODE,
      `octet string must be octet-aligned, got bitOffset=${bitOffset} bitLength=${bitLength}`,
      { bitOffset, bitLength })
  }
  const total = buf.length * 8
  if (bitOffset + bitLength > total) {
    throw err(CODES.DECODE,
      `need ${bitOffset + bitLength} bits but only ${total} were supplied`,
      { bitOffset, bitLength, available: total })
  }
  const start = (total - bitOffset - bitLength) / 8
  return Buffer.from(buf.subarray(start, start + bitLength / 8))
}

/** Place octets at an octet-aligned position. Returns a new buffer. */
function writeOctets (buf, bitOffset, bitLength, octets) {
  if (bitOffset % 8 !== 0 || bitLength % 8 !== 0) {
    throw err(CODES.ENCODE,
      `octet string must be octet-aligned, got bitOffset=${bitOffset} bitLength=${bitLength}`)
  }
  const total = buf.length * 8
  if (bitOffset + bitLength > total) {
    throw err(CODES.ENCODE, `cannot write ${bitLength} bits at offset ${bitOffset} into ${total} bits`)
  }
  const out = Buffer.from(buf)
  const start = (total - bitOffset - bitLength) / 8
  const width = bitLength / 8
  // Short values are padded with NUL on the right, as IO-Link string fields are.
  out.fill(0, start, start + width)
  octets.copy(out, start, 0, Math.min(octets.length, width))
  return out
}

/** Two's-complement sign extension of an unsigned BigInt of `bitLength` bits. */
function toSigned (raw, bitLength) {
  const signBit = 1n << BigInt(bitLength - 1)
  return raw & signBit ? raw - (1n << BigInt(bitLength)) : raw
}

/** Inverse of `toSigned`: wrap a signed BigInt into `bitLength` bits. */
function fromSigned (value, bitLength) {
  const mask = (1n << BigInt(bitLength)) - 1n
  return BigInt(value) & mask
}

/** Accept hex strings, arrays and Buffers as raw process data. */
function toBuffer (input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (Array.isArray(input)) return Buffer.from(input)
  if (typeof input === 'string') {
    const hex = input.trim().replace(/^0x/i, '').replace(/[\s:_-]/g, '')
    if (hex === '') return Buffer.alloc(0)
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw err(CODES.DECODE, `not a valid hex string: ${JSON.stringify(input)}`)
    }
    return Buffer.from(hex, 'hex')
  }
  throw err(CODES.DECODE, `cannot read process data from ${typeof input}`)
}

module.exports = {
  toBigInt,
  fromBigInt,
  readBits,
  writeBits,
  readOctets,
  writeOctets,
  toSigned,
  fromSigned,
  toBuffer
}
