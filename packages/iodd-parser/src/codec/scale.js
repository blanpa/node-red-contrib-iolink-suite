'use strict'

/**
 * Raw counts become engineering values through `value = raw * gradient + offset`.
 *
 * Doing that in binary floating point turns 2347 * 0.01 into
 * 23.470000000000002, which then travels all the way into a database. The
 * result is rounded to the precision the IODD itself implies: the decimals of
 * displayFormat ("Dec.2") when present, otherwise the decimals of the gradient.
 */

/** Decimal places in a number's literal form, e.g. 0.01 -> 2. */
function decimalsOf (value) {
  if (!Number.isFinite(value)) return 0
  const text = String(value)
  if (text.includes('e') || text.includes('E')) {
    const [mantissa, exp] = text.toLowerCase().split('e')
    const mantissaDecimals = (mantissa.split('.')[1] || '').length
    return Math.max(0, mantissaDecimals - Number(exp))
  }
  return (text.split('.')[1] || '').length
}

/** Round away binary representation noise without inventing precision. */
function tidy (value, decimals) {
  if (!Number.isFinite(value)) return value
  if (decimals !== undefined && decimals !== null) {
    const factor = 10 ** decimals
    return Math.round(value * factor) / factor
  }
  return Number(value.toPrecision(15))
}

/** Apply gradient/offset to a raw count. */
function applyScale (raw, { gradient, offset, decimals } = {}) {
  if (gradient === undefined && offset === undefined) return raw
  const g = gradient ?? 1
  const o = offset ?? 0
  if (typeof raw === 'bigint') {
    // Keep exactness when the scaling is a pure integer shift.
    if (Number.isInteger(g) && Number.isInteger(o)) return raw * BigInt(g) + BigInt(o)
    raw = Number(raw)
  }
  if (typeof raw !== 'number') return raw
  const places = decimals ?? decimalsOf(g)
  return tidy(raw * g + o, places)
}

/** Invert `applyScale`, returning the raw count to write. */
function removeScale (value, { gradient, offset } = {}) {
  if (gradient === undefined && offset === undefined) return value
  const g = gradient ?? 1
  const o = offset ?? 0
  if (typeof value === 'bigint') {
    if (Number.isInteger(g) && Number.isInteger(o) && g !== 0) return (value - BigInt(o)) / BigInt(g)
    value = Number(value)
  }
  if (typeof value !== 'number') return value
  if (g === 0) return 0
  return Math.round((value - o) / g)
}

module.exports = { applyScale, removeScale, decimalsOf, tidy }
