'use strict'
const zlib = require('node:zlib')
const { err, CODES } = require('./errors')

/**
 * Minimal ZIP reader for IODD packages.
 *
 * An IODD ZIP is a flat archive of one XML plus images, written by ordinary
 * tools - no encryption, no spanning, deflate or stored. Reading the central
 * directory directly keeps the package free of a zip dependency, which matters
 * for something that ends up inside a Node-RED install.
 */

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50

function findEndOfCentralDirectory (buf) {
  // The comment may be up to 64 KiB, so scan back from the end.
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** List the entries of a ZIP archive. */
function listEntries (buf) {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) throw err(CODES.PARSE, 'not a ZIP archive: no end-of-central-directory record')

  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw err(CODES.UNSUPPORTED, 'ZIP64 archives are not supported')
  }

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) {
      throw err(CODES.PARSE, `corrupt ZIP central directory at entry ${i}`)
    }
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Read one entry's bytes. */
function readEntry (buf, entry) {
  const local = entry.localOffset
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC_SIG) {
    throw err(CODES.PARSE, `corrupt ZIP local header for "${entry.name}"`)
  }
  const nameLength = buf.readUInt16LE(local + 26)
  const extraLength = buf.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const raw = buf.subarray(start, start + entry.compressedSize)

  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw err(CODES.UNSUPPORTED,
    `ZIP entry "${entry.name}" uses compression method ${entry.method}`, { method: entry.method })
}

/**
 * Pull the IODD XML out of an IODD ZIP.
 * Returns `{ name, xml }`. Throws when the archive holds no or several IODDs.
 */
function extractIodd (buf) {
  const entries = listEntries(buf).filter(e =>
    e.name.toLowerCase().endsWith('.xml') && !e.name.startsWith('__MACOSX'))
  if (!entries.length) {
    throw err(CODES.PARSE, 'ZIP contains no .xml file, so it is not an IODD package')
  }
  // Some vendors add auxiliary XML; the IODD itself is the one with IODevice.
  const decoded = entries.map(e => ({ name: e.name, xml: readEntry(buf, e).toString('utf8') }))
  const iodds = decoded.filter(d => d.xml.includes('<IODevice'))
  if (iodds.length === 1) return iodds[0]
  if (iodds.length > 1) {
    throw err(CODES.PARSE,
      `ZIP contains ${iodds.length} IODD files (${iodds.map(d => d.name).join(', ')}); ` +
      'extract the intended one and pass it directly',
      { candidates: iodds.map(d => d.name) })
  }
  return decoded[0]
}

module.exports = { listEntries, readEntry, extractIodd }
