#!/usr/bin/env node
'use strict'
/**
 * Regenerates src/units.js from the OPC Foundation's normative mapping of
 * IO-Link unitCodes to engineering units (Annex C of the OPC UA companion
 * specification "OPC UA for IO-Link Devices and IO-Link Masters").
 *
 *   node scripts/gen-units.js [path-or-url-to-EngineeringUnits.csv]
 *
 * The generated table is committed so the parser works offline.
 */
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = 'https://www.opcfoundation.org/UA/schemas/IOLink/1.0/EngineeringUnits.csv'
const out = path.join(__dirname, '..', 'lib', 'iodd', 'units.js')

async function load (src) {
  if (!src || /^https?:/.test(src || SOURCE)) {
    const res = await fetch(src || SOURCE)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${src || SOURCE}`)
    return await res.text()
  }
  return fs.readFileSync(src, 'utf8')
}

function parseCsv (text) {
  const rows = []
  // eslint-disable-next-line no-irregular-whitespace -- a literal BOM, on purpose
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = lines.shift().split(';')
  const iCode = header.indexOf('IO-Link unitCode')
  const iName = header.indexOf('DisplayName')
  const iDesc = header.indexOf('Description')
  if (iCode < 0 || iName < 0) throw new Error(`unexpected CSV header: ${header.join(';')}`)
  for (const line of lines) {
    if (!line.trim()) continue
    const cells = line.split(';')
    const code = Number(cells[iCode])
    if (!Number.isInteger(code)) continue
    rows.push({ code, symbol: (cells[iName] || '').trim(), name: (cells[iDesc] || '').trim() })
  }
  return rows
}

/**
 * The source lists two units for a handful of codes - 1050 is both "bushel (UK)"
 * and "bushel (US)". That ambiguity is in the normative data itself, so it is
 * carried into the table rather than resolved by picking one and hoping: the
 * first entry is the answer, the rest are reported as alternatives.
 */
function group (rows) {
  const byCode = new Map()
  for (const row of rows) {
    if (byCode.has(row.code)) byCode.get(row.code).push(row)
    else byCode.set(row.code, [row])
  }
  return [...byCode.entries()].sort((a, b) => a[0] - b[0])
}

/** Single quotes, so the generated file is what the linter expects. */
const quote = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

async function main () {
  const rows = parseCsv(await load(process.argv[2]))
  const grouped = group(rows)
  const body = grouped
    .map(([code, entries]) => {
      const [first, ...rest] = entries
      const alt = rest.length
        ? ', [' + rest.map(r => `[${quote(r.symbol)}, ${quote(r.name)}]`).join(', ') + ']'
        : ''
      return `  ${code}: [${quote(first.symbol)}, ${quote(first.name)}${alt}]`
    })
    .join(',\n')
  const src = `'use strict'
/**
 * IO-Link unitCode -> [symbol, name].
 *
 * GENERATED FILE - do not edit by hand. Run \`npm run gen:units\` to refresh.
 * Source: ${SOURCE}
 * (Annex C of "OPC UA for IO-Link Devices and IO-Link Masters", normative.)
 * ${grouped.length} unit codes.
 */

const UNITS = {
${body}
}

/**
 * Resolve a unitCode to \`{ code, symbol, name }\`, or \`null\` when unknown.
 *
 * A few codes are listed twice in the source. Those carry \`alternatives\`, so a
 * caller that cares can say "bushel, but the source is not sure which one"
 * rather than being told the wrong country's bushel with full confidence.
 */
function lookupUnit (code) {
  if (code === undefined || code === null || code === '') return null
  const n = Number(code)
  const hit = UNITS[n]
  if (!hit) return null
  const unit = { code: n, symbol: hit[0], name: hit[1] }
  if (hit[2]) unit.alternatives = hit[2].map(([symbol, name]) => ({ symbol, name }))
  return unit
}

module.exports = { UNITS, lookupUnit }
`
  fs.writeFileSync(out, src)
  console.log(`wrote ${out} with ${grouped.length} unit codes ` +
    `(${rows.length - grouped.length} listed more than once in the source)`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
