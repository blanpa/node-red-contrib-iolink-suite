'use strict'

/**
 * Every error this package throws is an IoddError carrying a stable `code`,
 * so callers can branch on the cause instead of matching message text.
 */
class IoddError extends Error {
  constructor (code, message, details = {}) {
    super(message)
    this.name = 'IoddError'
    this.code = code
    Object.assign(this, details)
  }
}

const CODES = {
  /** The file is not well-formed XML, or not an IODD at all. */
  PARSE: 'IODD_PARSE',
  /** Well-formed IODD, but it uses a construct this version does not implement. */
  UNSUPPORTED: 'IODD_UNSUPPORTED',
  /** The IODD describes several process data layouts and none was selected. */
  AMBIGUOUS_VARIANT: 'IODD_AMBIGUOUS_VARIANT',
  /** A referenced id (datatype, text, process data) does not exist in the file. */
  BROKEN_REF: 'IODD_BROKEN_REF',
  /** Raw data did not match the layout (too short, wrong length, bad value). */
  DECODE: 'IODD_DECODE',
  /** A value could not be encoded into the declared layout. */
  ENCODE: 'IODD_ENCODE'
}

const err = (code, message, details) => new IoddError(code, message, details)

module.exports = { IoddError, CODES, err }
