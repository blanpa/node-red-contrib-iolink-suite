'use strict'
const { XMLParser } = require('fast-xml-parser')
const { err, CODES } = require('./errors')

const ATTR = '@_'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  // Keep every value a string: IODD carries device ids, offsets and default
  // values that must not be reinterpreted (e.g. productId "#171939", or a
  // defaultValue of "0700" that is not the number 700).
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // Left at the parser's default, where a tag becomes an array only when it
  // repeats. Callers never see that difference: children() below always hands
  // back an array, which is the one place the normalising belongs.
  isArray: () => false
})

// The XML parser decodes the five named entities only. IODDs use numeric
// references for degree signs, umlauts and line breaks (&#176;, &#252;,
// &#10;), which would otherwise leak into keys and texts verbatim. The five
// markup characters are turned into their named form so they stay escaped.
const MARKUP = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&apos;' }
function decodeNumericEntities (xml) {
  return xml.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (m, ref) => {
    const code = ref[0] === 'x' || ref[0] === 'X' ? parseInt(ref.slice(1), 16) : Number(ref)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m
    return MARKUP[code] || String.fromCodePoint(code)
  })
}

/** Parse an IODD document into a plain object tree. */
function parseXml (xml) {
  if (Buffer.isBuffer(xml)) xml = xml.toString('utf8')
  if (typeof xml !== 'string') {
    throw err(CODES.PARSE, 'expected the IODD as a string or Buffer')
  }
  // Strip a UTF-8 BOM; several vendors ship one and it upsets strict parsers.
  // eslint-disable-next-line no-irregular-whitespace -- a literal BOM, on purpose
  xml = xml.replace(/^﻿/, '')
  xml = decodeNumericEntities(xml)
  let tree
  try {
    tree = parser.parse(xml)
  } catch (e) {
    throw err(CODES.PARSE, `not well-formed XML: ${e.message}`)
  }
  return tree
}

/**
 * Read attribute `name` off a node, tolerating a namespace prefix.
 * `xsi:type` is the one attribute IODD files consistently qualify, but the
 * prefix itself is only conventional, so it is resolved rather than assumed.
 */
function attr (node, name) {
  if (!node || typeof node !== 'object') return undefined
  const direct = node[ATTR + name]
  if (direct !== undefined) return direct
  const suffix = ':' + name
  for (const key of Object.keys(node)) {
    if (key.startsWith(ATTR) && key.endsWith(suffix)) return node[key]
  }
  return undefined
}

/** The `xsi:type` of a node, e.g. "RecordT" or "UIntegerT". */
const typeOf = node => attr(node, 'type')

/** Child element(s) by local name, always as an array (empty when absent). */
function children (node, name) {
  if (!node || typeof node !== 'object') return []
  let hit = node[name]
  if (hit === undefined) {
    const suffix = ':' + name
    for (const key of Object.keys(node)) {
      if (key.endsWith(suffix) && !key.startsWith(ATTR)) { hit = node[key]; break }
    }
  }
  if (hit === undefined || hit === null) return []
  return Array.isArray(hit) ? hit : [hit]
}

/** First child element by local name, or undefined. */
const child = (node, name) => children(node, name)[0]

/** Walk a path of local names, returning the first match at each level. */
function pick (node, ...path) {
  let cur = node
  for (const name of path) {
    cur = child(cur, name)
    if (cur === undefined) return undefined
  }
  return cur
}

/** Parse an attribute as an integer, returning `fallback` when absent/invalid. */
function intAttr (node, name, fallback = undefined) {
  const raw = attr(node, name)
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Parse an attribute as a float, returning `fallback` when absent/invalid. */
function floatAttr (node, name, fallback = undefined) {
  const raw = attr(node, name)
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Parse an attribute as a boolean ("true"/"1"). */
function boolAttr (node, name, fallback = undefined) {
  const raw = attr(node, name)
  if (raw === undefined || raw === '') return fallback
  return raw === 'true' || raw === '1'
}

module.exports = { parseXml, attr, typeOf, child, children, pick, intAttr, floatAttr, boolAttr, ATTR }
