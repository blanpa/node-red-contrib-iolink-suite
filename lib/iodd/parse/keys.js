'use strict'

/**
 * Turn a human-readable IODD name into an output key.
 *
 * Names come from the device vendor and routinely contain spaces, umlauts,
 * dots and slashes ("Aktueller Durchfluss", "P-n", "Messwert [°C]"). Those are
 * awkward as MQTT topic segments or JSON identifiers, so the caller picks a
 * style. `preserve` keeps the vendor's wording verbatim.
 */

const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' }

function asciify (input) {
  return String(input)
    .replace(/[äöüÄÖÜß]/g, c => TRANSLIT[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

function words (input) {
  return asciify(input)
    // Vendor names are often already camel case with no separator
    // ("SwitchingSignal1"), so split on case boundaries as well.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

const STYLES = {
  preserve: name => String(name).trim(),
  camel: name => {
    const w = words(name)
    if (!w.length) return ''
    return w[0].toLowerCase() + w.slice(1).map(p => p[0].toUpperCase() + p.slice(1)).join('')
  },
  pascal: name => words(name).map(p => p[0].toUpperCase() + p.slice(1)).join(''),
  snake: name => words(name).join('_').toLowerCase(),
  kebab: name => words(name).join('-').toLowerCase()
}

/**
 * Assign unique keys to a list of `{ name }`-ish records.
 * Collisions get a numeric suffix; empty results fall back to `fallback(i)`.
 */
function makeKeyer (style = 'preserve') {
  const transform = STYLES[style] || STYLES.preserve
  const used = new Map()
  return function keyFor (name, fallback) {
    let base = transform(name ?? '')
    if (!base) base = transform(fallback ?? '') || String(fallback ?? 'value')
    const seen = used.get(base)
    if (seen === undefined) { used.set(base, 1); return base }
    let n = seen + 1
    let candidate = `${base}_${n}`
    while (used.has(candidate)) { n++; candidate = `${base}_${n}` }
    used.set(base, n)
    used.set(candidate, 1)
    return candidate
  }
}

module.exports = { makeKeyer, STYLES }
