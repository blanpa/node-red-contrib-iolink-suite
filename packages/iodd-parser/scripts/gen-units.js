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
const out = path.join(__dirname, '..', 'src', 'units.js')

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

async function main () {
  const rows = parseCsv(await load(process.argv[2]))
  rows.sort((a, b) => a.code - b.code)
  const body = rows
    .map(r => `  ${r.code}: [${JSON.stringify(r.symbol)}, ${JSON.stringify(r.name)}]`)
    .join(',\n')
  const src = `'use strict'
/**
 * IO-Link unitCode -> [symbol, name].
 *
 * GENERATED FILE - do not edit by hand. Run \`npm run gen:units\` to refresh.
 * Source: ${SOURCE}
 * (Annex C of "OPC UA for IO-Link Devices and IO-Link Masters", normative.)
 * ${rows.length} unit codes.
 */

const UNITS = {
${body}
}

/** Resolve a unitCode to \`{ code, symbol, name }\`, or \`null\` when unknown. */
function lookupUnit (code) {
  if (code === undefined || code === null || code === '') return null
  const n = Number(code)
  const hit = UNITS[n]
  if (!hit) return null
  return { code: n, symbol: hit[0], name: hit[1] }
}

module.exports = { UNITS, lookupUnit }
`
  fs.writeFileSync(out, src)
  console.log(`wrote ${out} with ${rows.length} unit codes`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
