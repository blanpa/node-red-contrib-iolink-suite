'use strict'
const { attr, child, children } = require('../xml')
const { resolveDatatype } = require('./datatypes')
const { flatten } = require('./processData')
const { resolveCandidates } = require('./display')
const { makeKeyer } = require('./keys')
const { lookupStandardVariable } = require('../standard')

/**
 * Parse <VariableCollection> into the ISDU parameter model.
 *
 * Two kinds of entry appear: <Variable>, defined in full by the vendor, and
 * <StdVariableRef>, which names an object the specification already defines
 * (VendorName, SerialNumber, ...). Standard entries are filled in from
 * Table B.8 so callers get an index and a type either way.
 */
function buildVariables (deviceFunction, ctx) {
  const collection = child(deviceFunction, 'VariableCollection')
  const out = []

  for (const node of children(collection, 'Variable')) {
    const id = attr(node, 'id')
    const dtNode = child(node, 'Datatype') || child(node, 'DatatypeRef')
    let datatype = null
    let error
    try {
      datatype = resolveDatatype(dtNode, ctx)
    } catch (e) {
      // A single unsupported parameter must not sink the whole file: record it
      // and carry on, so the process data path stays usable.
      error = e.message
    }

    const display = ctx.display.variables.get(id)
    const infoFor = subindex => resolveCandidates(
      (subindex !== undefined && display && display.bySubindex.get(subindex)) ||
      (display && display.self), ctx.conditions)
    const keyFor = makeKeyer(ctx.keyStyle)
    const name = ctx.texts.nameOf(node, id)
    const variable = {
      id,
      index: Number(attr(node, 'index')),
      name,
      description: ctx.texts.descriptionOf(node),
      access: normaliseAccess(attr(node, 'accessRights')),
      dynamic: attr(node, 'dynamic') === 'true',
      defaultValue: attr(node, 'defaultValue')
    }
    if (error) {
      variable.unsupported = error
      out.push(variable)
      continue
    }
    variable.type = datatype.type
    variable.bitLength = datatype.bitLength
    const items = flatten(datatype, infoFor, keyFor, { name })
    if (datatype.type === 'Record' || datatype.type === 'Array') {
      variable.items = items
    } else {
      // A scalar parameter carries its metadata directly.
      const [only] = items
      for (const field of ['gradient', 'offset', 'unitCode', 'unit', 'unitName',
        'displayFormat', 'decimals', 'min', 'max', 'values', 'encoding', 'octetLength']) {
        if (only && only[field] !== undefined) variable[field] = only[field]
      }
      variable.subindex = 0
      variable.bitOffset = 0
    }
    if (datatype.octetLength !== undefined) variable.octetLength = datatype.octetLength
    out.push(variable)
  }

  for (const node of children(collection, 'StdVariableRef')) {
    const id = attr(node, 'id')
    const std = lookupStandardVariable(id)
    const defaultValue = attr(node, 'defaultValue')
    if (!std) {
      out.push({ id, standard: true, unsupported: `unknown StdVariableRef id "${id}"` })
      continue
    }
    const display = ctx.display.variables.get(id)
    const variable = { ...std, description: undefined }
    if (defaultValue !== undefined) variable.defaultValue = defaultValue
    const resolved = resolveCandidates(display && display.self, ctx.conditions).info
    if (resolved) Object.assign(variable, resolved)
    // A vendor may narrow a standard object's access, e.g. make a tag read-only.
    const restriction = resolved && resolved.accessRightRestriction
    if (restriction) variable.access = normaliseAccess(restriction)
    out.push(variable)
  }

  out.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
  return out
}

/** IODD writes "ro"/"wo"/"rw"; menus use the same tokens for restrictions. */
function normaliseAccess (raw) {
  if (!raw) return undefined
  const v = String(raw).toLowerCase()
  if (v === 'ro' || v === 'r') return 'ro'
  if (v === 'wo' || v === 'w') return 'wo'
  if (v === 'rw') return 'rw'
  return v
}

/** Index variables by id, for resolving process data <Condition> references. */
function indexVariables (list) {
  const map = new Map()
  for (const v of list) if (v.id) map.set(v.id, v)
  return map
}

module.exports = { buildVariables, indexVariables }
