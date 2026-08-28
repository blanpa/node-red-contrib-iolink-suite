'use strict'
const { attr, child, children, intAttr } = require('../xml')
const { lookupEvent } = require('../standard')

/**
 * Parse <EventCollection>.
 *
 * <StdEventRef code=".."> points at a specified EventCode; <Event code=".."
 * type=".."> is vendor defined and carries its own texts. Both are returned in
 * one list, with `standard` marking which is which.
 */
function buildEvents (deviceFunction, ctx) {
  const collection = child(deviceFunction, 'EventCollection')
  const out = []

  for (const node of children(collection, 'StdEventRef')) {
    const code = intAttr(node, 'code')
    if (code === undefined) continue
    const std = lookupEvent(code, 'device')
    out.push({ ...std, standard: true })
  }

  for (const node of children(collection, 'Event')) {
    const code = intAttr(node, 'code')
    if (code === undefined) continue
    const std = lookupEvent(code, 'device')
    out.push({
      code,
      hex: '0x' + code.toString(16).toUpperCase().padStart(4, '0'),
      // The vendor's own type wins; the spec table is the fallback.
      type: attr(node, 'type') || std.type,
      name: ctx.texts.nameOf(node, std.name),
      description: ctx.texts.descriptionOf(node),
      standard: false,
      vendorSpecific: Boolean(std.vendorSpecific)
    })
  }

  out.sort((a, b) => a.code - b.code)
  return out
}

module.exports = { buildEvents }
