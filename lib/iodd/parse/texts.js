'use strict'
const { attr, child, children } = require('../xml')

/**
 * Resolver over <ExternalTextCollection>.
 *
 * IODD keeps every human-readable string out of line and refers to it by
 * textId. Exactly one <PrimaryLanguage> is mandatory; further <Language>
 * blocks are optional translations. Lookup falls back
 * requested -> primary -> any -> undefined, so a partial translation degrades
 * to the primary language per string rather than failing.
 */
function buildTexts (deviceNode, preferred) {
  const collection = child(deviceNode, 'ExternalTextCollection')
  const byLang = new Map()
  let primaryLang = null

  const ingest = (node, isPrimary) => {
    if (!node) return
    const lang = (attr(node, 'lang') || '').toLowerCase() || 'und'
    if (isPrimary && !primaryLang) primaryLang = lang
    let table = byLang.get(lang)
    if (!table) { table = new Map(); byLang.set(lang, table) }
    for (const text of children(node, 'Text')) {
      const id = attr(text, 'id')
      if (id !== undefined) table.set(id, attr(text, 'value') ?? '')
    }
  }

  ingest(child(collection, 'PrimaryLanguage'), true)
  for (const lang of children(collection, 'Language')) ingest(lang, false)

  const wanted = (preferred || '').toLowerCase()
  // "de-DE" should find a "de" table and vice versa.
  const order = []
  const push = l => { if (l && !order.includes(l) && byLang.has(l)) order.push(l) }
  push(wanted)
  push(wanted.split('-')[0])
  for (const lang of byLang.keys()) if (lang.split('-')[0] === wanted.split('-')[0]) push(lang)
  push(primaryLang)
  for (const lang of byLang.keys()) push(lang)

  /** Resolve a textId. Returns `fallback` (default: the id itself) if unknown. */
  function get (textId, fallback) {
    if (textId === undefined || textId === null) return fallback
    for (const lang of order) {
      const hit = byLang.get(lang).get(textId)
      if (hit !== undefined && hit !== '') return hit
    }
    return fallback !== undefined ? fallback : textId
  }

  /** Resolve the <Name textId="..."/> child of a node. */
  const nameOf = (node, fallback) => get(attr(child(node, 'Name'), 'textId'), fallback)

  /** Resolve the <Description textId="..."/> child of a node. */
  const descriptionOf = node => {
    const id = attr(child(node, 'Description'), 'textId')
    return id === undefined ? undefined : get(id, undefined)
  }

  return {
    get,
    nameOf,
    descriptionOf,
    languages: [...byLang.keys()],
    primaryLanguage: primaryLang,
    resolvedLanguage: order[0] || null
  }
}

module.exports = { buildTexts }
