'use strict'
const { attr, typeOf, child, children, intAttr } = require('../xml')
const { err, CODES } = require('../errors')

/** Widths that the IO-Link specification fixes rather than declaring per use. */
const FIXED_BITS = { BooleanT: 1, Float32T: 32, TimeSpanT: 64, TimeT: 64 }

const KIND = {
  BooleanT: 'Boolean',
  UIntegerT: 'UInteger',
  IntegerT: 'Integer',
  Float32T: 'Float32',
  StringT: 'String',
  OctetStringT: 'OctetString',
  TimeSpanT: 'TimeSpan',
  TimeT: 'Time',
  ArrayT: 'Array',
  RecordT: 'Record'
}

const MAX_NESTING = 8

/** Collect <SingleValue> enum members declared on a datatype. */
function readSingleValues (node, texts) {
  const out = []
  for (const sv of children(node, 'SingleValue')) {
    const raw = attr(sv, 'value')
    if (raw === undefined) continue
    out.push({ value: raw, name: texts.nameOf(sv, raw), description: texts.descriptionOf(sv) })
  }
  return out
}

/** Collect the <ValueRange> bounds declared on a datatype. */
function readValueRange (node) {
  const vr = child(node, 'ValueRange')
  if (!vr) return {}
  const lower = attr(vr, 'lowerValue')
  const upper = attr(vr, 'upperValue')
  const out = {}
  if (lower !== undefined) out.min = Number(lower)
  if (upper !== undefined) out.max = Number(upper)
  return out
}

/**
 * Normalise a <Datatype>, <SimpleDatatype> or <DatatypeRef> node into a plain
 * descriptor. `ctx` carries the DatatypeCollection and the text resolver.
 */
function resolveDatatype (node, ctx, depth = 0) {
  if (!node) return null
  if (depth > MAX_NESTING) {
    throw err(CODES.UNSUPPORTED, `datatype nesting deeper than ${MAX_NESTING} levels`)
  }

  // <DatatypeRef datatypeId="DT_x"/> - or a node that carries the attribute.
  const ref = attr(node, 'datatypeId')
  if (ref !== undefined) {
    const target = ctx.datatypes.get(ref)
    if (!target) {
      throw err(CODES.BROKEN_REF, `DatatypeRef points at unknown datatypeId "${ref}"`, { datatypeId: ref })
    }
    const resolved = resolveDatatype(target, ctx, depth + 1)
    return { ...resolved, datatypeId: ref }
  }

  const xsi = typeOf(node)
  const kind = KIND[xsi]
  if (!kind) {
    throw err(CODES.UNSUPPORTED, `unknown datatype "${xsi}"`, { xsiType: xsi })
  }

  const base = { type: kind, ...readValueRange(node) }
  const values = readSingleValues(node, ctx.texts)
  if (values.length) base.values = values

  switch (kind) {
    case 'Boolean':
    case 'Float32':
      return { ...base, bitLength: FIXED_BITS[xsi] }

    case 'TimeSpan':
    case 'Time':
      // Fixed 8-octet types. Exposed as the raw integer: the IODD carries no
      // resolution for them, so inventing a unit here would be a guess.
      return { ...base, bitLength: FIXED_BITS[xsi], raw: true }

    case 'UInteger':
    case 'Integer': {
      const bitLength = intAttr(node, 'bitLength')
      if (!bitLength) {
        throw err(CODES.PARSE, `${xsi} without bitLength`, { xsiType: xsi })
      }
      return { ...base, bitLength }
    }

    case 'String':
    case 'OctetString': {
      const fixedLength = intAttr(node, 'fixedLength')
      if (!fixedLength) {
        throw err(CODES.PARSE, `${xsi} without fixedLength`, { xsiType: xsi })
      }
      const out = { ...base, bitLength: fixedLength * 8, octetLength: fixedLength }
      if (kind === 'String') out.encoding = attr(node, 'encoding') || 'UTF-8'
      return out
    }

    case 'Array': {
      const count = intAttr(node, 'count')
      const itemNode = child(node, 'SimpleDatatype') || child(node, 'DatatypeRef')
      if (!count || !itemNode) {
        throw err(CODES.PARSE, 'ArrayT without count or element datatype')
      }
      const item = resolveDatatype(itemNode, ctx, depth + 1)
      return { ...base, count, item, bitLength: count * item.bitLength }
    }

    case 'Record': {
      const declared = intAttr(node, 'bitLength')
      const items = []
      for (const ri of children(node, 'RecordItem')) {
        const itemNode = child(ri, 'SimpleDatatype') || child(ri, 'DatatypeRef')
        const datatype = resolveDatatype(itemNode, ctx, depth + 1)
        if (!datatype) {
          throw err(CODES.PARSE, `RecordItem subindex ${attr(ri, 'subindex')} has no datatype`)
        }
        items.push({
          subindex: intAttr(ri, 'subindex'),
          bitOffset: intAttr(ri, 'bitOffset', 0),
          name: ctx.texts.nameOf(ri, undefined),
          description: ctx.texts.descriptionOf(ri),
          datatype
        })
      }
      items.sort((a, b) => b.bitOffset - a.bitOffset)
      const spanned = items.reduce((max, it) => Math.max(max, it.bitOffset + it.datatype.bitLength), 0)
      return { ...base, bitLength: declared || spanned, items }
    }

    default:
      throw err(CODES.UNSUPPORTED, `datatype "${xsi}" is not implemented`, { xsiType: xsi })
  }
}

/** Index <DatatypeCollection> so DatatypeRef can be resolved by id. */
function buildDatatypeIndex (deviceFunction) {
  const map = new Map()
  const collection = child(deviceFunction, 'DatatypeCollection')
  for (const dt of children(collection, 'Datatype')) {
    const id = attr(dt, 'id')
    if (id !== undefined) map.set(id, dt)
  }
  return map
}

module.exports = { resolveDatatype, buildDatatypeIndex, KIND, FIXED_BITS }
