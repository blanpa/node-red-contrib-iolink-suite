'use strict'
const { attr, child, children, intAttr } = require('../xml')
const { resolveDatatype } = require('./datatypes')
const { makeKeyer } = require('./keys')
const { resolveCandidates, candidatesFor } = require('./display')
const { err, CODES } = require('../errors')

/**
 * Flatten a resolved datatype into the list of addressable values that make up
 * one process data block.
 *
 * RecordT contributes one entry per RecordItem; ArrayT one per element; every
 * other type is a single entry spanning the whole block.
 */
function flatten (datatype, infoFor, keyFor, opts = {}) {
  const items = []

  const build = (dt, { subindex, bitOffset, name, description, path }) => {
    const { info: meta, alternatives } = infoFor(subindex)
    const item = {
      key: keyFor(name, path),
      name: name ?? path,
      subindex,
      bitOffset,
      bitLength: dt.bitLength,
      type: dt.type
    }
    if (description) item.description = description
    if (dt.encoding) item.encoding = dt.encoding
    if (dt.min !== undefined) item.min = dt.min
    if (dt.max !== undefined) item.max = dt.max
    if (dt.values) item.values = dt.values
    if (dt.raw) item.raw = true
    Object.assign(item, meta || {})
    if (alternatives) {
      // Several menus scale this value differently and the deciding parameter
      // was not supplied, so it stays raw rather than silently wrong.
      item.scalingAmbiguous = alternatives
      if (opts.warnings) {
        opts.warnings.push(
          `"${item.name}" has ${alternatives.length} conflicting scalings ` +
          `(${alternatives.map(a => a.unit || a.unitCode || a.gradient).join(', ')}); ` +
          'value is reported raw. Supply the deciding parameter via { conditions }.')
      }
    }
    // A scaled item's declared range is in raw counts; expose it scaled too.
    if (item.gradient !== undefined || item.offset !== undefined) {
      const g = item.gradient ?? 1
      const o = item.offset ?? 0
      if (item.min !== undefined) item.min = item.min * g + o
      if (item.max !== undefined) item.max = item.max * g + o
    }
    items.push(item)
  }

  if (datatype.type === 'Record') {
    for (const ri of datatype.items) {
      if (ri.datatype.type === 'Record' || ri.datatype.type === 'Array') {
        // Nested composites inside a record are legal but vanishingly rare and
        // vendors disagree on the bit layout, so refuse rather than guess.
        throw err(CODES.UNSUPPORTED,
          `RecordItem subindex ${ri.subindex} contains a nested ${ri.datatype.type}, which is not supported`,
          { subindex: ri.subindex, nestedType: ri.datatype.type })
      }
      build(ri.datatype, {
        subindex: ri.subindex,
        bitOffset: ri.bitOffset,
        name: ri.name,
        description: ri.description,
        path: `subindex${ri.subindex}`
      })
    }
  } else if (datatype.type === 'Array') {
    const width = datatype.item.bitLength
    for (let i = 0; i < datatype.count; i++) {
      // Subindex 1 is the first array element; element 0 addresses the whole array.
      const subindex = i + 1
      build(datatype.item, {
        subindex,
        // Element 0 sits at the most significant end of the block.
        bitOffset: (datatype.count - 1 - i) * width,
        name: opts.name ? `${opts.name}[${i}]` : undefined,
        path: `element${i}`
      })
    }
  } else {
    build(datatype, { subindex: 0, bitOffset: 0, name: opts.name, path: 'value' })
  }

  return items
}

/** Parse one <ProcessDataIn>/<ProcessDataOut> element into a layout. */
function buildLayout (node, direction, ctx) {
  if (!node) return null
  const id = attr(node, 'id')
  const declaredBits = intAttr(node, 'bitLength')
  const dtNode = child(node, 'Datatype') || child(node, 'SimpleDatatype') || child(node, 'DatatypeRef')
  if (!dtNode) {
    // A ProcessDataIn/Out with no datatype means "no process data in this
    // direction" - legal, and different from a malformed file.
    return null
  }
  const datatype = resolveDatatype(dtNode, ctx)
  const name = ctx.texts.nameOf(node, undefined)
  const bitLength = declaredBits || datatype.bitLength
  const keyFor = makeKeyer(ctx.keyStyle)
  const infoFor = subindex =>
    resolveCandidates(candidatesFor(ctx.display, id, direction, subindex), ctx.conditions)
  const items = flatten(datatype, infoFor, keyFor, { name, warnings: ctx.warnings })

  return {
    id,
    direction,
    name,
    bitLength,
    octetLength: Math.ceil(bitLength / 8),
    type: datatype.type,
    items
  }
}

/** Read the <Condition> that selects a process data variant, if any. */
function readCondition (node, ctx) {
  const cond = child(node, 'Condition')
  if (!cond) return null
  const variableId = attr(cond, 'variableId')
  const out = {
    variableId,
    value: attr(cond, 'value'),
    subindex: intAttr(cond, 'subindex')
  }
  const variable = ctx.variableIndex && ctx.variableIndex.get(variableId)
  if (variable) {
    out.index = variable.index
    out.variableName = variable.name
  }
  return out
}

/**
 * Parse <ProcessDataCollection> into one entry per <ProcessData>.
 *
 * Devices whose layout depends on a parameter declare several <ProcessData>
 * blocks, each guarded by a <Condition> on an ISDU variable. They are all
 * returned; picking one is `selectVariant`'s job.
 */
function buildProcessData (deviceFunction, ctx) {
  const collection = child(deviceFunction, 'ProcessDataCollection')
  const variants = []
  for (const pd of children(collection, 'ProcessData')) {
    variants.push({
      id: attr(pd, 'id'),
      condition: readCondition(pd, ctx),
      in: buildLayout(child(pd, 'ProcessDataIn'), 'in', ctx),
      out: buildLayout(child(pd, 'ProcessDataOut'), 'out', ctx)
    })
  }
  return variants
}

module.exports = { buildProcessData, buildLayout, flatten }
